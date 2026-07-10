// VibeDeck TOKEN METER — odometer-style dashboard in a PTY pane
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
const CODEX_PRICE = { in: 1.25, out: 10, cachedFactor: 0.1 };

// ---------- ansi ----------
const ESC = '\x1b[';
const rgb = (hex, s) => {
  const n = parseInt(hex.slice(1), 16);
  return `${ESC}38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}${ESC}0m`;
};
const bold = s => `${ESC}1m${s}${ESC}22m`;
const dim = s => `${ESC}2m${s}${ESC}22m`;
const C_CLAUDE = '#d97757', C_CODEX = '#10a37f', C_GROK = '#9ca3af',
      C_GOLD = '#e0af68', C_TEXT = '#d8dee9', C_DIM = '#6b7280', C_RED = '#ef4444', C_OK = '#9ece6a';

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 10e6 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 100e3 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
const money = n => n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 100 ? n.toFixed(1) : n.toFixed(2);
const usd = n => '$' + money(n);
function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- big block digits (3 rows) ----------
const FONT = {
  '0': ['█▀▀█', '█  █', '█▄▄█'],
  '1': [' ▄█ ', '  █ ', ' ▄█▄'],
  '2': ['▀▀▀█', '▄▀▀▀', '█▄▄▄'],
  '3': ['▀▀▀█', ' ▀▀█', '▄▄▄█'],
  '4': ['█  █', '▀▀▀█', '   █'],
  '5': ['█▀▀▀', '▀▀▀█', '▄▄▄█'],
  '6': ['█▀▀▀', '█▀▀█', '█▄▄█'],
  '7': ['▀▀▀█', '  █ ', ' █  '],
  '8': ['█▀▀█', '█▀▀█', '█▄▄█'],
  '9': ['█▀▀█', '▀▀▀█', '▄▄▄█'],
  '.': ['  ', '  ', '█ '],
  ',': ['  ', '  ', '▞ '],
  '~': ['    ', '▄▀▄▟', '    '],
};
function bigNum(str, hex) {
  const rows = ['', '', ''];
  for (const ch of str) {
    const g = FONT[ch];
    if (!g) continue;
    for (let r = 0; r < 3; r++) rows[r] += g[r] + ' ';
  }
  return rows.map(r => rgb(hex, r));
}

// ---------- claude: per-message usage from project transcripts ----------
const claudeFiles = new Map(); // path -> { offset, leftover }
const claudeMsgs = new Map();  // message id -> { model, usage }
let claudeTs = { min: Infinity, max: 0 };
let claudeDay = midnight();

function collectClaude() {
  if (midnight() !== claudeDay) { claudeDay = midnight(); claudeFiles.clear(); claudeMsgs.clear(); claudeTs = { min: Infinity, max: 0 }; }
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
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
            if (ts && ts < claudeDay) continue;
            if (ts) { claudeTs.min = Math.min(claudeTs.min, ts); claudeTs.max = Math.max(claudeTs.max, ts); }
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
  const total = { in: 0, out: 0, cr: 0, cw: 0, calls: 0, cost: 0, models: [], firstTs: claudeTs.min, lastTs: claudeTs.max };
  for (const [fam, t] of Object.entries(byModel)) {
    const [pin, pout] = CLAUDE_PRICES[fam];
    const cost = (t.in * pin + t.out * pout + t.cr * pin * 0.1 + t.cw5 * pin * 1.25 + t.cw1 * pin * 2) / 1e6;
    total.models.push({ fam, cost, calls: t.calls });
    total.in += t.in; total.out += t.out; total.cr += t.cr; total.cw += t.cw5 + t.cw1;
    total.calls += t.calls; total.cost += cost;
  }
  total.models.sort((a, b) => b.cost - a.cost);
  return total;
}

// ---------- codex ----------
function collectCodex() {
  const d = new Date();
  const dir = path.join(HOME, '.codex', 'sessions',
    String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {}
  const total = { in: 0, cached: 0, out: 0, sessions: 0, planPct: null, planWindowMin: null, firstTs: Infinity, lastTs: 0 };
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const first = text.slice(0, 500).match(/"timestamp":"([^"]+)"/);
      if (first) total.firstTs = Math.min(total.firstTs, Date.parse(first[1]) || Infinity);
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
      if (rl && ts > total.lastTs) { total.lastTs = ts; total.planPct = rl.used_percent; total.planWindowMin = rl.window_minutes; }
    } catch {}
  }
  total.cost = ((total.in - total.cached) * CODEX_PRICE.in + total.cached * CODEX_PRICE.in * CODEX_PRICE.cachedFactor
    + total.out * CODEX_PRICE.out) / 1e6;
  return total;
}

// ---------- grok ----------
function collectGrok() {
  const base = path.join(HOME, '.grok', 'sessions');
  const day = midnight();
  const total = { estTokens: 0, sessions: 0, messages: 0, firstTs: Infinity, lastTs: 0 };
  let cwds = [];
  try { cwds = fs.readdirSync(base); } catch { return total; }
  for (const cw of cwds) {
    const dp = path.join(base, cw);
    let sessions = [];
    try { sessions = fs.readdirSync(dp, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const s of sessions) {
      const sp = path.join(dp, s);
      try {
        const st = fs.statSync(path.join(sp, 'chat_history.jsonl'));
        if (st.mtimeMs < day) continue;
        total.sessions++;
        total.estTokens += Math.round(st.size / 4);
        total.lastTs = Math.max(total.lastTs, st.mtimeMs);
        try {
          const sum = JSON.parse(fs.readFileSync(path.join(sp, 'summary.json'), 'utf8'));
          total.messages += sum.num_chat_messages || 0;
          const created = Date.parse(sum.created_at) || Infinity;
          total.firstTs = Math.min(total.firstTs, Math.max(created, day));
        } catch {}
      } catch {}
    }
  }
  return total;
}

// ---------- render ----------
const W = () => Math.max(44, Math.min(70, (process.stdout.columns || 80) - 2));

function tiles(pairs, hex) {
  // 2x2 tile grid: [[label, value], ...] — screenshot-style boxed stats
  const w = W();
  const cw = Math.floor((w - 3) / 2);
  const cell = (label, value) => ({
    top: rgb(C_DIM, label.toUpperCase().padEnd(cw - 1).slice(0, cw - 1)),
    val: bold(rgb(C_TEXT, String(value).padEnd(cw - 1).slice(0, cw - 1))),
  });
  const out = [];
  const bar = (l, m, r) => rgb('#2a2e38', l + '─'.repeat(cw) + m + '─'.repeat(cw) + r);
  const v = rgb('#2a2e38', '│');
  out.push(bar('┌', '┬', '┐'));
  for (let i = 0; i < pairs.length; i += 2) {
    const a = cell(...pairs[i]), b = cell(...(pairs[i + 1] || ['', '']));
    out.push(`${v} ${a.top}${v} ${b.top}${v}`);
    out.push(`${v} ${a.val}${v} ${b.val}${v}`);
    out.push(i + 2 < pairs.length ? bar('├', '┼', '┤') : bar('└', '┴', '┘'));
  }
  return out;
}

function card(hex, name, badge, dollar, subline, tilePairs, footnote) {
  const out = [];
  const w = W();
  const head = rgb(hex, '●') + ' ' + bold(rgb(hex, `${name} METER`)) + rgb(C_DIM, ' · LIVE');
  const badgeTxt = badge ? `${ESC}48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${ESC}38;2;22;24;29m ${badge} ${ESC}0m` : '';
  const headPlain = `* ${name} METER . LIVE`;
  out.push(head + ' '.repeat(Math.max(1, w - headPlain.length - (badge ? badge.length + 2 : 0))) + badgeTxt);
  const [big0, big1, big2] = bigNum(dollar.big, hex === C_GROK ? C_TEXT : C_GOLD);
  const pre = dollar.prefix ? rgb(C_DIM, dollar.prefix) + ' ' : '  ';
  out.push('  ' + big0, pre + big1, '  ' + big2);
  out.push(rgb(C_DIM, subline));
  out.push(...tiles(tilePairs, hex));
  if (footnote) out.push(rgb(C_DIM, footnote));
  return out;
}

function render() {
  const now = Date.now();
  const out = [];
  const box = k => (enabled.has(k) ? rgb(C_GOLD, '[x]') : rgb(C_DIM, '[ ]'));
  out.push(` ${box('claude')} ${rgb(C_CLAUDE, '1 claude')}  ${box('codex')} ${rgb(C_CODEX, '2 codex')}  ${box('grok')} ${rgb(C_GROK, '3 grok')}  ` + rgb(C_DIM, 'today · api-rate value'));
  out.push('');

  if (enabled.has('claude')) {
    const cl = collectClaude();
    const elapsed = cl.firstTs === Infinity ? 0 : now - cl.firstTs;
    const rate = elapsed > 60000 ? cl.cost / (elapsed / 3600000) : 0;
    out.push(...card(C_CLAUDE, 'CLAUDE', (cl.models[0]?.fam || 'CLAUDE').toUpperCase(),
      { prefix: '$', big: money(cl.cost) },
      ` $${rate.toFixed(2)}/hr  ${hms(elapsed)} elapsed  ${cl.calls} calls`,
      [['output tokens', fmt(cl.out)], ['input tokens', fmt(cl.in)],
       ['cache read', fmt(cl.cr)], ['cache write', fmt(cl.cw)]],
      cl.models.length ? ' ' + cl.models.map(m => `${m.fam} ${usd(m.cost)} (${m.calls})`).join(' · ') : ' no usage today'));
    out.push('');
  }
  if (enabled.has('codex')) {
    const cx = collectCodex();
    const elapsed = cx.firstTs === Infinity ? 0 : now - cx.firstTs;
    const rate = elapsed > 60000 ? cx.cost / (elapsed / 3600000) : 0;
    const plan = cx.planPct != null ? `plan ${cx.planPct}% of ${Math.round((cx.planWindowMin || 0) / 1440)}d window` : 'no sessions today';
    out.push(...card(C_CODEX, 'CODEX', 'GPT-5.X',
      { prefix: '$', big: money(cx.cost) },
      ` $${rate.toFixed(2)}/hr est  ${hms(elapsed)} elapsed  ${cx.sessions} sessions`,
      [['output tokens', fmt(cx.out)], ['input tokens', fmt(cx.in)],
       ['cached input', fmt(cx.cached)], ['plan used', cx.planPct != null ? cx.planPct + '%' : '—']],
      ' est api-rate · ' + plan));
    out.push('');
  }
  if (enabled.has('grok')) {
    const gr = collectGrok();
    const elapsed = gr.firstTs === Infinity ? 0 : now - gr.firstTs;
    const grBig = fmt(gr.estTokens); // FONT has no k/M glyph — suffix goes in the prefix slot
    out.push(...card(C_GROK, 'GROK', 'GROK 4.5',
      { prefix: '~' + (grBig.match(/[kM]$/)?.[0] || ''), big: grBig.replace(/[kM]$/, '') },
      ` ~${fmt(gr.estTokens)} tokens est  ${hms(elapsed)} elapsed  ${gr.sessions} sessions`,
      [['est tokens', '~' + fmt(gr.estTokens)], ['sessions', gr.sessions],
       ['messages', gr.messages], ['billing', 'flat sub']],
      ' grok logs no token counts — char estimate'));
    out.push('');
  }
  out.push(rgb(C_DIM, ` press 1/2/3 to toggle · refreshes ${REFRESH_MS / 1000}s · prices in meter-cli.js`));
  process.stdout.write(ESC + '2J' + ESC + 'H' + out.join('\r\n') + '\r\n');
}

process.stdin.resume();
process.stdin.on('data', (d) => {
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
