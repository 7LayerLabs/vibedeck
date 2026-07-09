// VibeDeck — one prompt, a deck of AI CLIs in live terminal panes
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');

const PORT = 18801;
const HOME = process.env.USERPROFILE || process.env.HOME;
const STATE_FILE = path.join(__dirname, 'state.json');
const LEGACY_PANES = path.join(__dirname, 'panes.json');
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const PLAYBOOK_DIR = path.join(__dirname, 'playbooks');
const PIPELINE_DIR = path.join(__dirname, 'pipelines');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
fs.mkdirSync(PIPELINE_DIR, { recursive: true });

// The kinds of CLI a pane can run. Any kind can run in multiple panes at once.
// ready: the pane isn't accepting typed prompts until this paints (dialogs/init eat input).
// Patterns are space-elastic (\s*) because Ink paints sometimes swallow spaces.
const NPM_BIN = path.join(process.env.APPDATA || '', 'npm');
const ROSTER = [
  { id: 'claude', label: 'CLAUDE', cmd: path.join(NPM_BIN, 'claude.cmd'), ready: /⏵⏵|Try\s*"|\?\s*for\s*shortcuts/ },
  { id: 'codex',  label: 'CODEX',  cmd: path.join(NPM_BIN, 'codex.cmd'),  ready: /gpt-[\d.]|› / },
  { id: 'grok',   label: 'GROK',   cmd: 'C:\\Users\\Derek\\.grok\\bin\\grok.exe', ready: /grok-|Shift\+Tab/i },
  { id: 'shell',  label: 'SHELL',  cmd: 'powershell -NoLogo', ready: /PS .*>/ },
];
const TRUST_DIALOG = /Quick\s*safety\s*check|Do\s*you\s*trust/i;
const DEFAULT_ACTIVE = ['claude', 'codex', 'grok'];
const MAX_PANES = 4;
const BUFFER_MAX = 400 * 1024;
const ROUND_MAX = 200 * 1024;

const kindOf = id => ROSTER.find(r => r.id === id);

const LOG_FILE = path.join(DATA_DIR, 'server.log');
function slog(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ---------- state (pane kinds + project dir) ----------
let state = { kinds: DEFAULT_ACTIVE, cwd: HOME, recents: [HOME] };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
} catch {
  try { state.kinds = JSON.parse(fs.readFileSync(LEGACY_PANES, 'utf8')); } catch {}
}
state.kinds = state.kinds.filter(k => kindOf(k)).slice(0, MAX_PANES);
if (!state.kinds.length) state.kinds = DEFAULT_ACTIVE;
if (!fs.existsSync(state.cwd)) state.cwd = HOME;
function saveState() {
  state.kinds = [...sessions.values()].map(s => s.kind);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- text cleanup for compare/relay/judge ----------
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?<>= ]*[a-zA-Z]/g, '') // space allowed: '\x1b[0 q' cursor-style seqs
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
// symbol-only lines (borders, spinners) and TUI chrome get dropped
const SYMBOL_LINE = new RegExp('^[-=>.*\\s' +
  '\\u2500\\u2502\\u256D\\u256E\\u2570\\u256F\\u2594\\u2581\\u2590\\u258C\\u259B\\u259C\\u259D\\u2598\\u2588' +
  '\\u23F5\\u00B7\\u25D0\\u25D3\\u25D1\\u25D2\\u273B\\u2736\\u273D\\u2722\\u25E6\\u203A\\u276F]+$');
const CHROME_LINE = /esc to interrupt|bypass permissions|shift\+tab|tokens\)|\/status|\/effort|\/model|mcp server|claude max|working \(|thinking with|↓ ?\d+ tokens|^\W*\w+…|^.{0,15}…$|\[pasted text|paste again to expand|ctrl\+g to edit|turn completed in [\d.]+s/i;
function cleanTui(s, prompt) {
  // cursor-forward becomes a space (Ink uses it instead of spaces — without this
  // words fuse: "AgreatTUIapp"), and cursor-positioning (CUP, up/down) becomes a
  // newline — claude repaints whole screens with those, so stripping alone fuses
  // every screen line into one mega-line and the filters below nuke real content
  const segmented = s
    .replace(/\x1b\[\d*C/g, ' ')
    .replace(/\x1b\[[0-9;]*[HfABEFd]/g, '\n');
  const lines = stripAnsi(segmented).split(/[\r\n]+/);
  const out = [];
  const seen = new Set();
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const normPrompt = prompt ? norm(prompt) : '';
  const promptKey = normPrompt.slice(0, 60) || null;
  for (const l of lines) {
    const t = l.trim();
    if (!t) { out.push(''); continue; }
    if (!/[a-zA-Z]{3,}/.test(t)) continue; // spinner shrapnel: "o7", "* h g", "n 61"
    if (/^\W{0,3}\w+ for \d+s$/.test(t)) continue; // "✻ Cogitated for 5s"
    if (SYMBOL_LINE.test(t)) continue;
    if (CHROME_LINE.test(t)) continue;
    const key = norm(t);
    if (promptKey && key.includes(promptKey)) continue; // echo of the prompt itself
    // partial input-box paints of a multi-line prompt ("Verdict: Concept", …)
    if (normPrompt && key.length >= 6 && normPrompt.includes(key)) continue;
    if (seen.has(key)) continue; // TUI repaints duplicate lines constantly
    seen.add(key);
    out.push(t.replace(/\s{2,}/g, ' '));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- server ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/addon-webgl', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-webgl')));

const server = app.listen(PORT, () => slog(`VibeDeck on http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

const sessions = new Map(); // instance id -> session (insertion order = pane order)
let instanceSeq = 0;
let lastRound = null; // { ts, prompt, targets: [ids] }

function broadcastWs(msg) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(raw);
}

function spawnPane(kindId, instanceId, extraArgs) {
  const entry = kindOf(kindId);
  const id = instanceId || `${kindId}-${++instanceSeq}`;
  const cmd = entry.cmd + (extraArgs ? ' ' + extraArgs : '');
  slog(`spawn ${id}: ${cmd}`);
  let proc;
  try {
    proc = pty.spawn('cmd.exe', ['/c', cmd], {
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: state.cwd,
      env: process.env,
    });
  } catch (e) {
    slog(`spawn FAILED ${id}: ${e.message}`);
    const dead = { kind: kindId, proc: null, buffer: `[failed to launch: ${e.message}]`, alive: false,
                   extraArgs: extraArgs || '', roundOut: '', inRound: false, lastDataTs: 0, queue: [] };
    sessions.set(id, dead);
    setTimeout(() => broadcastWs({ type: 'exit', pane: id, code: -1 }), 100);
    return id;
  }
  const session = { kind: kindId, proc, buffer: '', alive: true, extraArgs: extraArgs || '', roundOut: '', inRound: false,
                    lastDataTs: Date.now(), queue: [] };
  sessions.set(id, session);

  // guard against stale events: after a restart/replace, the killed process's
  // onData/onExit can still fire for a pane id now owned by a fresh session
  proc.onData((data) => {
    if (sessions.get(id) !== session) return;
    session.lastDataTs = Date.now();
    session.buffer = (session.buffer + data).slice(-BUFFER_MAX);
    if (session.inRound) session.roundOut = (session.roundOut + data).slice(-ROUND_MAX);
    // auto-clear claude's startup trust dialog — it eats typed prompts otherwise
    if (kindId === 'claude' && !session.trustHandled && TRUST_DIALOG.test(stripAnsi(session.buffer))) {
      session.trustHandled = true;
      slog(`trust dialog cleared for ${id}`);
      setTimeout(() => { if (session.alive) proc.write('\r'); }, 400);
    }
    broadcastWs({ type: 'data', pane: id, data });
  });
  proc.onExit(({ exitCode }) => {
    session.alive = false;
    if (sessions.get(id) !== session) return;
    slog(`exit ${id} code ${exitCode}`);
    broadcastWs({ type: 'exit', pane: id, code: exitCode });
  });
  return id;
}

// a pane is ready for a typed prompt once its input UI has painted and it has
// gone quiet — fresh CLIs (npm shims, trust dialogs, init) silently eat early text
function isReady(s) {
  if (!s.alive || s.buffer.length < 50 || Date.now() - s.lastDataTs < 1200) return false;
  const tail = stripAnsi(s.buffer.slice(-4000));
  if (TRUST_DIALOG.test(stripAnsi(s.buffer.slice(-1500)))) return false;
  const pat = kindOf(s.kind).ready;
  return !pat || pat.test(tail);
}
function writePrompt(s, text) {
  s.proc.write(text);
  // multi-line text arrives as a paste; Enter too early lands mid-ingest and
  // never submits (claude shows "[Pasted text #N]" with the prompt stuck in the box)
  const delay = text.includes('\n') ? Math.min(3000, 600 + text.split('\n').length * 25) : 150;
  setTimeout(() => { if (s.alive) s.proc.write('\r'); }, delay);
}
// flush queued prompts when their pane becomes ready. The 30s failsafe covers
// panes that never go quiet (grok animates constantly) but must NOT fire while
// a startup dialog is up — the text would be eaten and Enter would answer it.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.queue.length || !s.alive) { if (!s.alive) s.queue = []; continue; }
    const dialogUp = TRUST_DIALOG.test(stripAnsi(s.buffer.slice(-1500)));
    if (isReady(s) || (!dialogUp && Date.now() - s.queue[0].ts > 30000)) {
      const item = s.queue.shift();
      if (s.inRound) s.roundOut = ''; // round starts when the prompt actually lands
      slog(`flush queued prompt to ${[...sessions.entries()].find(([, v]) => v === s)?.[0]}`);
      writePrompt(s, item.text);
    }
  }
}, 400);

function reorderSessions(order) {
  const entries = order.map(id => [id, sessions.get(id)]);
  sessions.clear();
  for (const [id, s] of entries) sessions.set(id, s);
}

const paneInfo = id => {
  const s = sessions.get(id);
  return { id, kind: s.kind, label: kindOf(s.kind).label };
};

function readHistory(n = 100) {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n')
      .slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function readPlaybooks() {
  try {
    return fs.readdirSync(PLAYBOOK_DIR).filter(f => f.endsWith('.md')).map(f => ({
      name: f.replace(/\.md$/, '').replace(/[-_]/g, ' '),
      text: fs.readFileSync(path.join(PLAYBOOK_DIR, f), 'utf8').trim(),
    }));
  } catch { return []; }
}

function readPipelines() {
  try {
    return fs.readdirSync(PIPELINE_DIR).filter(f => f.endsWith('.json')).map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, f), 'utf8'));
        if (!p.name || !Array.isArray(p.steps) || !p.steps.length) return null;
        if (!p.steps.every(st => kindOf(st.kind) && typeof st.prompt === 'string')) return null;
        return p;
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function roundResponses() {
  if (!lastRound) return [];
  return lastRound.targets.filter(id => sessions.has(id)).map(id => {
    const s = sessions.get(id);
    return { pane: id, kind: s.kind, label: kindOf(s.kind).label, text: cleanTui(s.roundOut, lastRound.prompt), rawLen: s.roundOut.length };
  });
}

// judge: headless claude -p over the last round (prompt guard keeps it non-agentic)
let judging = false;
function runJudge() {
  if (judging) return;
  const responses = roundResponses().filter(r => r.text.length > 10);
  if (!lastRound || responses.length < 2) {
    broadcastWs({ type: 'judgement', ok: false, text: 'Need a broadcast round with at least 2 answers to judge.' });
    return;
  }
  judging = true;
  const parts = responses.map((r, i) => `--- ANSWER ${i + 1} (${r.label}) ---\n${r.text.slice(0, 5000)}`);
  const judgePrompt =
`You are judging answers from different AI coding assistants to the same prompt. The transcripts may contain terminal rendering noise; judge the substance.

THE PROMPT WAS:
${(lastRound.prompt || '').slice(0, 2000)}

${parts.join('\n\n')}

Give your verdict:
1. WINNER: which answer number and why (2-3 sentences)
2. For each answer, one line on what it missed or got wrong
3. BEST MERGED TAKE: a short synthesis of the strongest ideas

Plain text only. Do not use any tools. Do not read or write any files. Reply directly.`;

  const child = spawn('cmd.exe', ['/c', 'claude', '-p'], { cwd: __dirname, env: process.env });
  let out = '', err = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('close', () => {
    clearTimeout(timer);
    judging = false;
    broadcastWs({ type: 'judgement', ok: !!out.trim(), text: out.trim() || ('Judge failed: ' + err.slice(0, 400)) });
  });
  child.stdin.write(judgePrompt);
  child.stdin.end();
}

// ---------- pipeline runner (auto-relay chains, one at a time) ----------
// A step is "done" when its pane's cleaned output stops growing for STABLE_MS
// and the pane looks idle. cleanTui filters spinners, so constant animation
// can't fake progress. NOTE: the ROSTER ready patterns are startup-screen
// signals — claude's post-answer idle screen is just "❯", so they must NOT be
// used as a done condition (that hangs the step forever).
const PIPE_STABLE_MS = 8000;
const PIPE_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const BUSY_TAIL = /esc\s+to\s+interrupt/i;
let pipeline = null; // { def, prompt, output, step, paneId, stepText, stepStart, lastCleanLen, stableSince }

function firstPaneOfKind(kind) {
  for (const [id, s] of sessions) if (s.kind === kind && s.alive) return id;
  return null;
}

function endPipeline(outcome, text) {
  const name = pipeline?.def.name;
  pipeline = null;
  broadcastWs({ type: 'pipeline', state: outcome, name, text: text || '' });
}

function startPipeline(name, prompt) {
  if (pipeline) return broadcastWs({ type: 'pipeline', state: 'error', name, text: 'a pipeline is already running — cancel it first' });
  const def = readPipelines().find(p => p.name === name);
  if (!def) return broadcastWs({ type: 'pipeline', state: 'error', name, text: 'unknown pipeline' });
  const missing = def.steps.find(st => !firstPaneOfKind(st.kind));
  if (missing) return broadcastWs({ type: 'pipeline', state: 'error', name, text: `needs a ${kindOf(missing.kind).label} pane — add one first` });
  slog(`pipeline start: ${name}`);
  pipeline = { def, prompt, output: '', step: -1 };
  advancePipeline();
}

function advancePipeline() {
  const p = pipeline;
  p.step++;
  if (p.step >= p.def.steps.length) {
    slog(`pipeline done: ${p.def.name}`);
    return endPipeline('done');
  }
  const stepDef = p.def.steps[p.step];
  const paneId = firstPaneOfKind(stepDef.kind);
  if (!paneId) return endPipeline('error', `no live ${kindOf(stepDef.kind).label} pane for step ${p.step + 1}`);
  const s = sessions.get(paneId);
  const text = stepDef.prompt
    .replace(/\{prompt\}/g, p.prompt)
    .replace(/\{output\}/g, p.output)
    .replace(/\r?\n/g, '\n');
  Object.assign(p, { paneId, stepText: text, stepStart: Date.now(), lastCleanLen: 0, stableSince: 0 });
  lastRound = { ts: Date.now(), prompt: text, targets: [paneId] }; // compare shows the live step
  s.roundOut = '';
  s.inRound = true;
  if (isReady(s)) writePrompt(s, text);
  else s.queue.push({ text, ts: Date.now() });
  slog(`pipeline step ${p.step + 1}/${p.def.steps.length} → ${paneId}`);
  broadcastWs({ type: 'pipeline', state: 'step', name: p.def.name, step: p.step, total: p.def.steps.length, pane: paneId, label: kindOf(stepDef.kind).label });
}

setInterval(() => {
  const p = pipeline;
  if (!p || p.step < 0) return;
  const s = sessions.get(p.paneId);
  if (!s || !s.alive) return endPipeline('error', `pane ${p.paneId} died mid-step`);
  if (Date.now() - p.stepStart > PIPE_STEP_TIMEOUT_MS) return endPipeline('error', `step ${p.step + 1} timed out`);
  if (s.queue.length) return; // prompt hasn't landed yet
  const clean = cleanTui(s.roundOut, p.stepText);
  if (clean.length < 10) return; // no real answer yet
  if (clean.length !== p.lastCleanLen) { p.lastCleanLen = clean.length; p.stableSince = Date.now(); return; }
  if (Date.now() - p.stableSince < PIPE_STABLE_MS) return;
  // idle check: a done CLI goes raw-quiet (claude/codex); grok shimmers forever
  // even when idle, so for still-painting panes fall back to the busy-marker veto
  const rawQuiet = Date.now() - s.lastDataTs > 4000;
  if (!rawQuiet && BUSY_TAIL.test(stripAnsi(s.buffer.slice(-1500)))) return; // still working
  p.output = clean;
  advancePipeline();
}, 1000);

for (const kind of state.kinds) spawnPane(kind);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    panes: [...sessions.keys()].map(paneInfo),
    roster: ROSTER.map(r => ({ id: r.id, label: r.label })),
    maxPanes: MAX_PANES,
    cwd: state.cwd,
    recents: state.recents,
    history: readHistory(),
    playbooks: readPlaybooks(),
    pipelines: readPipelines().map(p => ({ name: p.name, steps: p.steps.map(st => kindOf(st.kind).label) })),
  }));
  if (pipeline) ws.send(JSON.stringify({ type: 'pipeline', state: 'step', name: pipeline.def.name,
    step: pipeline.step, total: pipeline.def.steps.length, pane: pipeline.paneId,
    label: kindOf(pipeline.def.steps[pipeline.step].kind).label }));
  for (const [id, s] of sessions) {
    ws.send(JSON.stringify({ type: 'data', pane: id, data: s.buffer, replay: true }));
    if (!s.alive) ws.send(JSON.stringify({ type: 'exit', pane: id, code: null }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handleMessage(msg, ws); } catch (e) { slog(`handler error (${msg.type}): ${e.stack}`); }
  });

  function handleMessage(msg, ws) {
    const s = sessions.get(msg.pane);

    if (msg.type === 'input' && s && s.alive) {
      s.proc.write(msg.data);
    } else if (msg.type === 'broadcast') {
      const targets = msg.targets.filter(id => sessions.get(id)?.alive);
      lastRound = { ts: Date.now(), prompt: msg.data, targets };
      try { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: lastRound.ts, text: msg.data }) + '\n'); } catch {}
      for (const id of targets) {
        const t = sessions.get(id);
        t.roundOut = '';
        t.inRound = true;
        if (isReady(t)) writePrompt(t, msg.data);
        else t.queue.push({ text: msg.data, ts: Date.now() });
      }
      broadcastWs({ type: 'roundStarted', ts: lastRound.ts, targets });
    } else if (msg.type === 'relay' && s) {
      const to = sessions.get(msg.to);
      if (!to || !to.alive) return;
      const src = cleanTui(s.roundOut || s.buffer.slice(-24 * 1024)).slice(-12 * 1024);
      if (!src) return;
      const fromLabel = kindOf(s.kind).label;
      const text = `Here is output from another AI assistant (${fromLabel}). Use it as context and act on it:\n\n${src}`.replace(/\r?\n/g, '\n');
      to.roundOut = '';
      to.inRound = true;
      if (isReady(to)) writePrompt(to, text);
      else to.queue.push({ text, ts: Date.now() });
      broadcastWs({ type: 'relayed', from: msg.pane, to: msg.to });
    } else if (msg.type === 'round') {
      ws.send(JSON.stringify({ type: 'round', prompt: lastRound?.prompt || '', ts: lastRound?.ts || 0, responses: roundResponses() }));
    } else if (msg.type === 'judge') {
      broadcastWs({ type: 'judging' });
      runJudge();
    } else if (msg.type === 'histdel') {
      const items = readHistory(10000).filter(h => h.ts !== msg.ts);
      try { fs.writeFileSync(HISTORY_FILE, items.map(h => JSON.stringify(h)).join('\n') + (items.length ? '\n' : '')); } catch {}
    } else if (msg.type === 'playbooks') {
      ws.send(JSON.stringify({ type: 'playbooks', items: readPlaybooks() }));
    } else if (msg.type === 'pipelines') {
      ws.send(JSON.stringify({ type: 'pipelines', items: readPipelines().map(p => ({ name: p.name, steps: p.steps.map(st => kindOf(st.kind).label) })) }));
    } else if (msg.type === 'pipeline') {
      const prompt = String(msg.prompt || '').trim();
      if (!prompt) return;
      try { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: Date.now(), text: prompt }) + '\n'); } catch {}
      startPipeline(msg.name, prompt);
    } else if (msg.type === 'pipelineCancel') {
      if (pipeline) { slog(`pipeline cancelled: ${pipeline.def.name}`); endPipeline('cancelled', 'cancelled — the current pane keeps running, later steps are dropped'); }
    } else if (msg.type === 'setcwd') {
      let dir = String(msg.dir || '').trim().replace(/^"|"$/g, '');
      if (!dir) return;
      try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
      dir = path.resolve(dir);
      state.cwd = dir;
      state.recents = [dir, ...state.recents.filter(r => r.toLowerCase() !== dir.toLowerCase())].slice(0, 8);
      // relaunch every pane in the new project dir
      for (const [id, sess] of [...sessions]) {
        const order = [...sessions.keys()];
        if (sess.alive) { try { sess.proc.kill(); } catch {} }
        sessions.delete(id);
        spawnPane(sess.kind, id, sess.extraArgs);
        reorderSessions(order);
      }
      saveState();
      broadcastWs({ type: 'cwdChanged', cwd: state.cwd, recents: state.recents });
    } else if (msg.type === 'resize' && s && s.alive) {
      const cols = Math.max(2, msg.cols | 0), rows = Math.max(2, msg.rows | 0);
      try { s.proc.resize(cols, rows); } catch {}
    } else if (msg.type === 'restart' && s) {
      const order = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      // optional msg.args relaunches with new CLI flags (e.g. codex -m gpt-5.4); otherwise keep prior flags
      spawnPane(s.kind, msg.pane, typeof msg.args === 'string' ? msg.args : s.extraArgs);
      reorderSessions(order);
      broadcastWs({ type: 'restarted', pane: msg.pane });
    } else if (msg.type === 'add') {
      if (!kindOf(msg.kind) || sessions.size >= MAX_PANES) return;
      const id = spawnPane(msg.kind);
      saveState();
      broadcastWs({ type: 'paneAdded', pane: paneInfo(id) });
    } else if (msg.type === 'close') {
      if (!s || sessions.size <= 1) return;
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      saveState();
      broadcastWs({ type: 'paneRemoved', pane: msg.pane });
    } else if (msg.type === 'reorder') {
      const cur = [...sessions.keys()];
      const order = Array.isArray(msg.order) ? msg.order : [];
      if (order.length !== cur.length || !cur.every(id => order.includes(id))) return;
      reorderSessions(order);
      saveState();
      broadcastWs({ type: 'reordered', order });
    } else if (msg.type === 'replace') {
      if (!kindOf(msg.kind) || !s) return;
      const oldOrder = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      const newId = spawnPane(msg.kind);
      reorderSessions(oldOrder.map(id => id === msg.pane ? newId : id));
      saveState();
      broadcastWs({ type: 'paneReplaced', old: msg.pane, pane: paneInfo(newId), order: [...sessions.keys()] });
    }
  }
});
