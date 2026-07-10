// Token meter collectors — reads each CLI's local usage logs for TODAY.
// claude: ~/.claude/projects/**/*.jsonl per-message usage (full detail)
// codex:  ~/.codex/sessions/Y/M/D/rollout-*.jsonl cumulative totals + plan %
// grok:   ~/.grok/sessions — no token log; char-based estimate, labeled
// Costs are API-RATE VALUE (what today would cost at pay-per-token rates).
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// $/MTok base rates. Claude cache derives from input: read 0.1x, write 1.25x (5m) / 2x (1h).
// Codex/grok rates are ESTIMATES — edit freely.
const CLAUDE_PRICES = { fable: [10, 50], opus: [5, 25], sonnet: [3, 15], haiku: [1, 5] };
const CODEX_PRICE = { in: 1.25, out: 10, cachedFactor: 0.1 };
const GROK_PRICE = { in: 3, out: 15 }; // grok-4.5 est

function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- claude (incremental byte-offset parsing; files are append-only) ----------
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
  const out = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, models: [],
                firstTs: claudeTs.min === Infinity ? null : claudeTs.min, lastTs: claudeTs.max || null };
  for (const [fam, t] of Object.entries(byModel)) {
    const [pin, pout] = CLAUDE_PRICES[fam];
    const cost = (t.in * pin + t.out * pout + t.cr * pin * 0.1 + t.cw5 * pin * 1.25 + t.cw1 * pin * 2) / 1e6;
    out.models.push({ name: fam, cost, calls: t.calls });
    out.in += t.in; out.out += t.out; out.cacheRead += t.cr; out.cacheWrite += t.cw5 + t.cw1;
    out.calls += t.calls; out.cost += cost;
  }
  out.models.sort((a, b) => b.cost - a.cost);
  return out;
}

// ---------- codex ----------
function collectCodex() {
  const d = new Date();
  const dir = path.join(HOME, '.codex', 'sessions',
    String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {}
  const out = { in: 0, cached: 0, out: 0, sessions: 0, planPct: null, planWindowDays: null, firstTs: null, lastTs: null };
  let latest = 0;
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const first = text.slice(0, 500).match(/"timestamp":"([^"]+)"/);
      if (first) {
        const t = Date.parse(first[1]);
        if (t && (!out.firstTs || t < out.firstTs)) out.firstTs = t;
      }
      const idx = text.lastIndexOf('"token_count"');
      if (idx === -1) continue;
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const lineEnd = text.indexOf('\n', idx);
      const e = JSON.parse(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
      const u = e.payload?.info?.total_token_usage;
      if (!u) continue;
      out.in += u.input_tokens || 0;
      out.cached += u.cached_input_tokens || 0;
      out.out += u.output_tokens || 0;
      out.sessions++;
      const ts = Date.parse(e.timestamp) || 0;
      if (ts > latest) {
        latest = ts;
        out.lastTs = ts;
        const rl = e.payload?.rate_limits?.secondary;
        if (rl) { out.planPct = rl.used_percent; out.planWindowDays = Math.round((rl.window_minutes || 0) / 1440); }
      }
    } catch {}
  }
  out.cost = ((out.in - out.cached) * CODEX_PRICE.in + out.cached * CODEX_PRICE.in * CODEX_PRICE.cachedFactor
    + out.out * CODEX_PRICE.out) / 1e6;
  return out;
}

// ---------- grok ----------
// grok logs no token counts. Estimate from actual user/assistant message
// content only — the raw files are dominated by the system prompt and JSON
// envelope, which made a size-based estimate wildly high.
const grokCache = new Map(); // chat_history path -> { mtimeMs, est, msgs }
function grokEstimate(fp, st) {
  const hit = grokCache.get(fp);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  let estIn = 0, estOut = 0, msgs = 0;
  try {
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        const role = e.type === 'user' || e.role === 'user' ? 'user'
          : e.type === 'assistant' || e.role === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const content = e.content ?? e.message?.content ?? '';
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map(b => b?.text || '').join('') : '';
        const t = Math.round(text.length / 4);
        if (role === 'user') estIn += t; else estOut += t;
        msgs++;
      } catch {}
    }
  } catch {}
  const rec = { mtimeMs: st.mtimeMs, estIn, estOut, msgs };
  grokCache.set(fp, rec);
  return rec;
}

function collectGrok() {
  const base = path.join(HOME, '.grok', 'sessions');
  const day = midnight();
  const out = { estTokens: 0, estIn: 0, estOut: 0, cost: 0, sessions: 0, messages: 0, firstTs: null, lastTs: null };
  let cwds = [];
  try { cwds = fs.readdirSync(base); } catch { return out; }
  for (const cw of cwds) {
    const dp = path.join(base, cw);
    let sessions = [];
    try { sessions = fs.readdirSync(dp, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const s of sessions) {
      const sp = path.join(dp, s);
      try {
        const fp = path.join(sp, 'chat_history.jsonl');
        const st = fs.statSync(fp);
        if (st.mtimeMs < day) continue;
        const { estIn, estOut, msgs } = grokEstimate(fp, st);
        if (!msgs) continue; // idle pane spawns with no conversation don't count
        out.sessions++;
        out.estIn += estIn;
        out.estOut += estOut;
        out.estTokens += estIn + estOut;
        out.messages += msgs;
        if (!out.lastTs || st.mtimeMs > out.lastTs) out.lastTs = st.mtimeMs;
        try {
          const sum = JSON.parse(fs.readFileSync(path.join(sp, 'summary.json'), 'utf8'));
          const created = Math.max(Date.parse(sum.created_at) || 0, day);
          if (created && (!out.firstTs || created < out.firstTs)) out.firstTs = created;
        } catch {}
      } catch {}
    }
  }
  out.cost = (out.estIn * GROK_PRICE.in + out.estOut * GROK_PRICE.out) / 1e6;
  return out;
}

module.exports = {
  collect() {
    return { ts: Date.now(), claude: collectClaude(), codex: collectCodex(), grok: collectGrok() };
  },
};
