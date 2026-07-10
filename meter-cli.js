// VibeDeck TOKEN METER — terminal dashboard for a pane (runs in a PTY like any CLI)
// Reads local usage logs: claude ~/.claude/projects/**.jsonl (full usage),
// codex ~/.codex/sessions/Y/M/D/rollout-*.jsonl (cumulative totals + plan %),
// grok ~/.grok/sessions (no token log — char-based estimate, labeled).
// Everything is TODAY (local midnight). Costs are API-RATE VALUE — what today
// would cost at pay-per-token rates, not what flat subscriptions charge.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const REFRESH_MS = 10000;

// which meters to show: arg like "claude+codex" (or "all"); keys 1/2/3 toggle live
const ALL = ['claude', 'codex', 'grok'];
const arg = (process.argv[2] || 'all').toLowerCase();
const enabled = new Set(arg === 'all' ? ALL : arg.split(/[+,]/).filter(k => ALL.includes(k)));
if (!enabled.size) ALL.forEach(k => enabled.add(k));

// $/MTok base rates. Claude cache derives from input: read 0.1x, write 1.25x (5m) / 2x (1h).
// Codex/grok rates are ESTIMATES — edit freely.
const CLAUDE_PRICES = { fable: [10, 50], opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] };
const CODEX_PRICE = { in: 1.25, out: 10, cachedFactor: 0.1, est: true };

// ---------- ansi helpers ----------
const ESC = '\x1b[';
const c = (n, s) => `${ESC}38;5;${n}m${s}${ESC}0m`;
const bold = s => `${ESC}1m${s}${ESC}0m`;
const dim = s => `${ESC}2m${s}${ESC}0m`;
const ORANGE = 208, GREEN = 42, GRAY = 250, GOLD = 178, RED = 203;
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 0 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 100e3 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
const usd = n => '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- claude: per-message usage from project transcripts ----------
// Files are append-only; keep a byte offset per file and only parse new lines.
const claudeFiles = new Map(); // path -> { offset, leftover }
const claudeMsgs = new Map();  // message id -> { model, usage } (last write wins)
let claudeDay = midnight();

function collectClaude() {
  if (midnight() !== claudeDay) { claudeDay = midnight(); claudeFiles.clear(); claudeMsgs.clear(); }
  const projDir = path.join(HOME, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projDir); } catch { return summarizeClaude(); }
  for (const d of dirs) {
    let files = [];
    const dp = path.join(projDir, d);
    try { files = fs.readdirSync(dp).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dp, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < claudeDay) continue;
      let rec = claudeFiles.get(fp);
      if (!rec) { rec = { offset: 0, leftover: '' }; claudeFiles.set(fp, rec); }
      if (st.size <= rec.offset) continue;
      let fd;
      try {
        fd = fs.openSync(fp, 'r');
        const len = st.size - rec.offset;
        if (len > 64 * 1024 * 1024) { rec.offset = st.size; fs.closeSync(fd); continue; }
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, rec.offset);
        fs.closeSync(fd);
        rec.offset = st.size;
        const text = rec.leftover + buf.toString('utf8');
        const lines = text.split('\n');
        rec.leftover = lines.pop() || '';
        for (const line of lines) {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
          try {
            const e = JSON.parse(line);
            const m = e.message;
            if (!m || !m.usage || !m.id) continue;
            if (e.timestamp && Date.parse(e.timestamp) < claudeDay) continue;
            claudeMsgs.set(m.id, { model: m.model || '?', usage: m.usage });
          } catch {}
        }
      } catch { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
    }
  }
  return summarizeClaude();
}

function summarizeClaude() {
  const byModel = {};
  for (const { model, usage } of claudeMsgs.values()) {
    const fam = ['fable', 'opus', 'sonnet', 'haiku'].find(k => model.includes(k)) || 'opus';
    const t = byModel[fam] || (byModel[fam] = { in: 0, out: 0, cr: 0, cw5: 0, cw1: 0, calls: 0 });
    t.in += usage.input_tokens || 0;
    t.out += usage.output_tokens || 0;
    t.cr += usage.cache_read_input_tokens || 0;
    const cc = usage.cache_creation || {};
    if (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens) {
      t.cw5 += cc.ephemeral_5m_input_tokens || 0;
      t.cw1 += cc.ephemeral_1h_input_tokens || 0;
    } else t.cw5 += usage.cache_creation_input_tokens || 0;
    t.calls++;
  }
  let total = { in: 0, out: 0, cr: 0, cw: 0, calls: 0, cost: 0 };
  const models = [];
  for (const [fam, t] of Object.entries(byModel)) {
    const [pin, pout] = CLAUDE_PRICES[fam];
    const cost = (t.in * pin + t.out * pout + t.cr * pin * 0.1 + t.cw5 * pin * 1.25 + t.cw1 * pin * 2) / 1e6;
    models.push({ fam, cost, calls: t.calls });
    total.in += t.in; total.out += t.out; total.cr += t.cr; total.cw += t.cw5 + t.cw1;
    total.calls += t.calls; total.cost += cost;
  }
  models.sort((a, b) => b.cost - a.cost);
  return { ...total, models };
}

// ---------- codex: last cumulative token_count per rollout file ----------
function collectCodex() {
  const d = new Date();
  const dir = path.join(HOME, '.codex', 'sessions',
    String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {}
  const total = { in: 0, cached: 0, out: 0, sessions: 0, planPct: null, planWindowMin: null };
  let latestTs = 0;
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const idx = text.lastIndexOf('"token_count"');
      if (idx === -1) continue;
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const lineEnd = text.indexOf('\n', idx);
      const e = JSON.parse(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
      const u = e.payload?.info?.total_token_usage;
      if (!u) continue;
      total.in += u.input_tokens || 0;
      total.cached += u.cached_input_tokens || 0;
      total.out += u.output_tokens || 0;
      total.sessions++;
      const ts = Date.parse(e.timestamp) || 0;
      const rl = e.payload?.rate_limits?.secondary;
      if (rl && ts > latestTs) { latestTs = ts; total.planPct = rl.used_percent; total.planWindowMin = rl.window_minutes; }
    } catch {}
  }
  total.cost = ((total.in - total.cached) * CODEX_PRICE.in + total.cached * CODEX_PRICE.in * CODEX_PRICE.cachedFactor
    + total.out * CODEX_PRICE.out) / 1e6;
  return total;
}

// ---------- grok: no token log — char-based estimate over today's sessions ----------
function collectGrok() {
  const base = path.join(HOME, '.grok', 'sessions');
  const day = midnight();
  const total = { estTokens: 0, sessions: 0, messages: 0 };
  let cwds = [];
  try { cwds = fs.readdirSync(base); } catch { return total; }
  for (const cw of cwds) {
    const dp = path.join(base, cw);
    let sessions = [];
    try { sessions = fs.readdirSync(dp, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const s of sessions) {
      const sp = path.join(dp, s);
      try {
        const chat = path.join(sp, 'chat_history.jsonl');
        const st = fs.statSync(chat);
        if (st.mtimeMs < day) continue;
        total.sessions++;
        total.estTokens += Math.round(st.size / 4); // rough: ~4 bytes/token
        try {
          const sum = JSON.parse(fs.readFileSync(path.join(sp, 'summary.json'), 'utf8'));
          total.messages += sum.num_chat_messages || 0;
        } catch {}
      } catch {}
    }
  }
  return total;
}

// ---------- render ----------
function line(w) { return dim('─'.repeat(w)); }
function render() {
  const w = Math.max(40, (process.stdout.columns || 80) - 1);
  const now = new Date().toTimeString().slice(0, 8);
  const box = k => (enabled.has(k) ? c(GOLD, '[x]') : dim('[ ]'));
  const out = [];
  out.push(bold(c(GOLD, ' ⛽ TOKEN METER')) + dim(` · today · ${now} · api-rate value (flat subs don't bill per token)`));
  out.push(` ${box('claude')} ${c(ORANGE, '1 claude')}  ${box('codex')} ${c(GREEN, '2 codex')}  ${box('grok')} ${c(GRAY, '3 grok')}` + dim('   (click pane, press 1/2/3 to toggle)'));
  out.push(line(w));

  if (enabled.has('claude')) {
    const cl = collectClaude();
    out.push(bold(c(ORANGE, ' CLAUDE')) + '  ' + bold(c(GOLD, usd(cl.cost))) + dim(` api-rate · ${cl.calls} calls`));
    out.push(`   in ${bold(fmt(cl.in))} · out ${bold(fmt(cl.out))} · cache r ${fmt(cl.cr)} / w ${fmt(cl.cw)}`);
    if (cl.models.length) {
      // per-model lines — two claude panes on different models each get their own row
      for (const m of cl.models) out.push(`   ${c(ORANGE, m.fam.padEnd(7))} ${bold(c(GOLD, usd(m.cost)))}${dim(` · ${m.calls} calls`)}`);
    } else out.push(dim('   no usage today'));
    out.push(line(w));
  }
  if (enabled.has('codex')) {
    const cx = collectCodex();
    out.push(bold(c(GREEN, ' CODEX')) + '  ' + bold(c(GOLD, usd(cx.cost))) + dim(` est api-rate · ${cx.sessions} sessions`));
    out.push(`   in ${bold(fmt(cx.in))} (cached ${fmt(cx.cached)}) · out ${bold(fmt(cx.out))}`);
    out.push(cx.planPct != null
      ? `   plan ${bold(c(cx.planPct > 75 ? RED : GREEN, cx.planPct + '%'))} of ${Math.round((cx.planWindowMin || 0) / 1440)}d window used`
      : dim('   no sessions today'));
    out.push(line(w));
  }
  if (enabled.has('grok')) {
    const gr = collectGrok();
    out.push(bold(c(GRAY, ' GROK')) + '  ' + bold(`~${fmt(gr.estTokens)} tokens`) + dim(` est · ${gr.sessions} sessions · ${gr.messages} msgs`));
    out.push(dim('   grok logs no token counts — char-based estimate · flat sub'));
    out.push(line(w));
  }
  out.push(dim(` refreshes every ${REFRESH_MS / 1000}s · prices in meter-cli.js`));

  process.stdout.write(ESC + '2J' + ESC + 'H' + out.join('\r\n') + '\r\n');
}

process.stdin.resume();
process.stdin.on('data', (d) => {
  // 1/2/3 toggle sections; everything else (broadcast text, Enter) is ignored
  let changed = false;
  for (const ch of d.toString()) {
    const k = { 1: 'claude', 2: 'codex', 3: 'grok' }[ch];
    if (!k) continue;
    if (enabled.has(k) && enabled.size > 1) enabled.delete(k);
    else enabled.add(k);
    changed = true;
  }
  if (changed) render();
});
process.stdout.on('resize', render);
render();
setInterval(render, REFRESH_MS);
