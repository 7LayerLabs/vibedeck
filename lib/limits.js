'use strict';
// Plan usage per CLI for the sidebar meters. Every number comes from the CLI itself:
//   Claude  `claude -p /usage` (a local command: no model call, no cost) -> session and weekly %
//   Codex   rate_limits recorded in its session logs -> % of each limit window + reset time
//   Grok    usage.json in each session folder -> real tokens and cost (Grok exposes no plan limit,
//           so its bar compares today with the busiest day of the last week)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// "Current session: 4% used · resets Sep 26, 6:29pm (America/New_York)"
function parseClaudeUsage(text) {
  const out = { windows: [] };
  const re = /Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n(]+))?/gi;
  for (const m of String(text).matchAll(re)) {
    const scope = m[2] ? m[2].trim() : '';
    const label = m[1].toLowerCase() === 'session' ? '5-hour session' : scope && !/all models/i.test(scope) ? `weekly, ${scope}` : 'weekly';
    out.windows.push({ label, pct: Number(m[3]), resets: (m[4] || '').trim() });
  }
  return out.windows.length ? out : null;
}

function claudeUsage({ command, env, timeoutMs = 60000 }) {
  return new Promise(resolve => {
    const isCmd = process.platform === 'win32' && /\.cmd$/i.test(command);
    let child;
    try {
      child = spawn(isCmd ? 'cmd.exe' : command, isCmd ? ['/d', '/s', '/c', `""${command}" -p --output-format json"`] : ['-p', '--output-format', 'json'],
        { cwd: os.tmpdir(), env, windowsHide: true, windowsVerbatimArguments: isCmd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve(parseClaudeUsage(JSON.parse(out).result)); } catch { resolve(null); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end('/usage');
  });
}

// The newest rate_limits Codex wrote, from the most recently changed session logs.
function windowLabel(minutes) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  return minutes ? `${Math.round(minutes / 60)}-hour` : 'limit';
}
function codexUsage(home = os.homedir()) {
  const root = path.join(home, '.codex', 'sessions');
  const files = [];
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { const fp = path.join(dir, f); files.push({ fp, size: fs.statSync(fp).size, name: f }); } } catch {}
  }
  // rollout names start with the session's start time, so name order is time order; the size
  // check covers logs still open (Windows keeps their modified time at creation)
  files.sort((a, b) => b.name.localeCompare(a.name));
  let best = null;
  for (const { fp } of files.slice(0, 15)) {
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    const idx = text.lastIndexOf('"rate_limits"');
    if (idx === -1) continue;
    const start = text.lastIndexOf('\n', idx) + 1, end = text.indexOf('\n', idx);
    try {
      const e = JSON.parse(text.slice(start, end === -1 ? undefined : end));
      const ts = Date.parse(e.timestamp) || 0;
      const rl = e.payload?.rate_limits;
      if (rl && (!best || ts > best.ts)) best = { ts, rl };
    } catch {}
  }
  if (!best) return null;
  const windows = [best.rl.primary, best.rl.secondary].filter(Boolean).map(w => ({
    label: windowLabel(w.window_minutes), pct: Number(w.used_percent) || 0,
    resets: w.resets_at ? new Date(w.resets_at * 1000).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '',
  }));
  return { windows, plan: best.rl.plan_type || '', asOf: best.ts, limitReached: !!best.rl.rate_limit_reached_type };
}

// Grok: real tokens and cost per day from usage.json files (cost is stored in 1e-10 dollar ticks).
function grokUsage(home = os.homedir()) {
  const base = path.join(home, '.grok', 'sessions');
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const weekAgo = Date.now() - 7 * 86400000;
  const days = {};
  let cwds = [];
  try { cwds = fs.readdirSync(base); } catch { return null; }
  for (const cw of cwds) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(base, cw)); } catch { continue; }
    for (const s of sessions) {
      const fp = path.join(base, cw, s, 'usage.json');
      try {
        if (fs.statSync(fp).mtimeMs < weekAgo) continue;
        const u = JSON.parse(fs.readFileSync(fp, 'utf8'));
        // count each turn on the day it ended, so a session spanning midnight splits correctly
        for (const turn of u.turns || []) {
          const t = Date.parse(turn.endedAt) || 0;
          if (t < weekAgo) continue;
          const k = dayKey(t), d = days[k] || (days[k] = { tokens: 0, cost: 0 });
          d.tokens += (turn.inputTokens || 0) + (turn.outputTokens || 0);
          d.cost += (turn.costUsdTicks || 0) / 1e10;
        }
      } catch {}
    }
  }
  const today = days[dayKey(Date.now())] || { tokens: 0, cost: 0 };
  const busiest = Math.max(today.cost, ...Object.values(days).map(d => d.cost));
  return { today, busiestCost: busiest };
}

module.exports = { parseClaudeUsage, claudeUsage, codexUsage, grokUsage, windowLabel };
