// VibeDeck — one prompt, a deck of AI CLIs in live terminal panes
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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
const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
fs.mkdirSync(PIPELINE_DIR, { recursive: true });
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// The kinds of CLI a pane can run. Any kind can run in multiple panes at once.
// ready: the pane isn't accepting typed prompts until this paints (dialogs/init eat input).
// Patterns are space-elastic (\s*) because Ink paints sometimes swallow spaces.
const IS_WIN = process.platform === 'win32';
const NPM_BIN = path.join(process.env.APPDATA || '', 'npm');
// windows needs the npm .cmd shims / grok.exe path; mac & linux find them on PATH
const CLI = name => IS_WIN ? path.join(NPM_BIN, `${name}.cmd`) : name;
const USER_SHELL = process.env.SHELL || '/bin/zsh';
// flags: every pane launches in its CLI's skip-permissions mode
const ROSTER = [
  { id: 'claude', label: 'CLAUDE', cmd: CLI('claude'), flags: '--dangerously-skip-permissions', ready: /⏵⏵|Try\s*"|\?\s*for\s*shortcuts/ },
  { id: 'codex',  label: 'CODEX',  cmd: CLI('codex'),  flags: '--dangerously-bypass-approvals-and-sandbox', ready: /gpt-[\d.]|› / },
  { id: 'grok',   label: 'GROK',   cmd: IS_WIN ? path.join(HOME, '.grok', 'bin', 'grok.exe') : 'grok', flags: '--always-approve', ready: /grok-|Shift\+Tab/i },
  { id: 'shell',  label: 'SHELL',  cmd: IS_WIN ? 'powershell -NoLogo' : USER_SHELL, ready: IS_WIN ? /PS .*>/ : undefined },
  { id: 'notes',  label: 'NOTES' }, // PTY-less: a plain-english notepad pane
];
const TRUST_DIALOG = /Quick\s*safety\s*check|Do\s*you\s*trust/i;
// claude's bypass-mode acceptance dialog defaults to "No, exit" — Enter would
// kill the pane; typing "2" selects "Yes, I accept"
const BYPASS_WARN = /Bypass\s*Permissions\s*mode/i;
const DEFAULT_ACTIVE = ['claude', 'codex', 'grok'];
const MAX_PANES = 5;
const BUFFER_MAX = 400 * 1024;
const ROUND_MAX = 200 * 1024;

const kindOf = id => ROSTER.find(r => r.id === id);

const LOG_FILE = path.join(DATA_DIR, 'server.log');
function slog(...args) {
  const line = `${new Date().toISOString()} ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
// a helper process dying mid-write (EPIPE) must not take the whole deck down
process.on('uncaughtException', e => slog(`UNCAUGHT: ${e.stack || e}`));
process.on('unhandledRejection', e => slog(`UNHANDLED REJECTION: ${e}`));

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
// cleanTui doubles as the settle-detection signal (settledAnswer keys on its
// length stability) — display-only cleanup improvements go in extractAnswer
const { stripAnsi, segmentAnsi, cleanTui, extractAnswer } = require('./lib/screen');

// ---------- CLI health (boot): missing binaries surface in the UI ----------
const HEALTH = ROSTER.filter(r => ['claude', 'codex', 'grok'].includes(r.id)).map(r => {
  let ok = false;
  try { ok = IS_WIN ? fs.existsSync(r.cmd) : spawnSync('which', [r.cmd]).status === 0; } catch {}
  return { id: r.id, label: r.label, ok, detail: ok ? '' : `${r.cmd} not found` };
});
slog(`cli health: ${HEALTH.map(h => `${h.id}=${h.ok ? 'ok' : 'MISSING'}`).join(' ')}`);
// judge kinds with a reliable non-interactive mode (claude -p, codex exec).
// grok has no clean headless path — deliberately not offered.
const JUDGE_KINDS = HEALTH.filter(h => h.ok && ['claude', 'codex'].includes(h.id)).map(h => h.id);
if (!JUDGE_KINDS.length) JUDGE_KINDS.push('claude');

// ---------- server ----------
const app = express();
// no-cache so a plain reload always gets the current UI after an upgrade
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: res => res.set('Cache-Control', 'no-cache'),
}));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/addon-webgl', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-webgl')));

const meterData = require('./meter-data');
app.get('/api/meter', (req, res) => {
  // session slice starts at the earliest spawn among this kind's live panes —
  // restarting a pane moves it forward, resetting the session meter to zero
  const since = {};
  for (const s of sessions.values()) {
    if (!s.alive || !s.spawnTs) continue;
    if (['claude', 'codex', 'grok'].includes(s.kind)) since[s.kind] = Math.min(since[s.kind] ?? Infinity, s.spawnTs);
  }
  try { res.json(meterData.collect({ cwd: state.cwd, since })); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/meter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'meter.html')));

// localhost only: panes run CLIs in skip-permissions mode — never expose that to the LAN
const server = app.listen(PORT, '127.0.0.1', () => slog(`VibeDeck on http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

const sessions = new Map(); // instance id -> session (insertion order = pane order)
let instanceSeq = 0;
let lastRound = null; // { ts, prompt, targets: [ids], pending: Map(id -> settle state) }

function broadcastWs(msg) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(raw);
}

// PTY output is coalesced per pane for FLUSH_MS before hitting the wire — TUI
// repaints arrive as storms of tiny chunks, and one ws message per chunk is
// what makes a busy deck feel choppy
const FLUSH_MS = 25;
function flushOut(id, session) {
  if (session.flushTimer) { clearTimeout(session.flushTimer); session.flushTimer = null; }
  if (!session.pendingOut) return;
  const out = session.pendingOut;
  session.pendingOut = '';
  if (sessions.get(id) === session) broadcastWs({ type: 'data', pane: id, data: out });
}

function spawnPane(kindId, instanceId, extraArgs, yolo) {
  const entry = kindOf(kindId);
  const id = instanceId || `${kindId}-${++instanceSeq}`;
  if (!entry.cmd) { // PTY-less pane (meter): client renders it as an iframe
    sessions.set(id, { kind: kindId, proc: null, alive: true, buffer: '', extraArgs: '', yolo: false,
                       roundOut: '', inRound: false, lastDataTs: 0, queue: [] });
    return id;
  }
  yolo = yolo !== false; // skip-permissions on unless the pane's toggle turned it off
  const cmd = entry.cmd + (entry.flags && yolo ? ' ' + entry.flags : '') + (extraArgs ? ' ' + extraArgs : '');
  slog(`spawn ${id}: ${cmd}`);
  let proc;
  try {
    // windows: cmd.exe /c runs the .cmd shims; mac/linux: login shell so the
    // user's PATH (homebrew, nvm) is loaded before the CLI launches
    proc = pty.spawn(IS_WIN ? 'cmd.exe' : USER_SHELL, IS_WIN ? ['/c', cmd] : ['-lc', cmd], {
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: state.cwd,
      env: process.env,
    });
  } catch (e) {
    slog(`spawn FAILED ${id}: ${e.message}`);
    const dead = { kind: kindId, proc: null, buffer: `[failed to launch: ${e.message}]`, alive: false,
                   extraArgs: extraArgs || '', yolo, roundOut: '', inRound: false, lastDataTs: 0, queue: [] };
    sessions.set(id, dead);
    setTimeout(() => broadcastWs({ type: 'exit', pane: id, code: -1 }), 100);
    return id;
  }
  const session = { kind: kindId, proc, buffer: '', alive: true, extraArgs: extraArgs || '', yolo, roundOut: '', inRound: false,
                    lastDataTs: Date.now(), spawnTs: Date.now(), queue: [], pendingOut: '', flushTimer: null };
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
    // auto-accept the bypass-permissions warning (first run only; "2" = Yes)
    if (kindId === 'claude' && !session.bypassHandled && session.buffer.length < 20000
        && BYPASS_WARN.test(stripAnsi(session.buffer)) && /yes, i accept/i.test(stripAnsi(session.buffer))) {
      session.bypassHandled = true;
      slog(`bypass warning accepted for ${id}`);
      setTimeout(() => { if (session.alive) proc.write('2'); }, 400);
    }
    session.pendingOut += data;
    if (!session.flushTimer) session.flushTimer = setTimeout(() => { session.flushTimer = null; flushOut(id, session); }, FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    session.alive = false;
    if (sessions.get(id) !== session) return;
    flushOut(id, session); // last output must land before the exit banner
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
  return { id, kind: s.kind, label: kindOf(s.kind).label, yolo: s.yolo !== false };
};

function readHistory(n = 100) {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n')
      .slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// the server is the only history writer — clients learn entries (with the real
// ts, so delete works before a reload) via the 'hist' broadcast. Consecutive
// repeats of the same prompt are stored once, shell-style.
let lastHistText = readHistory(1)[0]?.text || '';
function appendHistory(ts, text) {
  if (text === lastHistText) return;
  lastHistText = text;
  try { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts, text }) + '\n'); } catch {}
  broadcastWs({ type: 'hist', item: { ts, text } });
}

// ---------- round history: prompt + all answers + winner, capped jsonl ----------
const ROUNDS_FILE = path.join(DATA_DIR, 'rounds.jsonl');
const ROUNDS_MAX = 200;
function readRounds(n = ROUNDS_MAX) {
  try {
    return fs.readFileSync(ROUNDS_FILE, 'utf8').trim().split('\n')
      .slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
let pendingCrown = null; // crown clicked before the round settled and got written
function appendRound(entry) {
  if (pendingCrown && pendingCrown.ts === entry.ts) { entry.winnerKind = pendingCrown.kind; pendingCrown = null; }
  const items = readRounds().slice(-(ROUNDS_MAX - 1));
  items.push(entry);
  try { fs.writeFileSync(ROUNDS_FILE, items.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch (e) { slog(`rounds write failed: ${e.message}`); }
}
function crownRound(ts, kind) {
  if (!ts || !kindOf(kind)) return;
  const items = readRounds();
  const it = items.find(r => r.ts === ts);
  if (!it) { pendingCrown = { ts, kind }; return; } // round still settling — applied on write
  it.winnerKind = kind;
  try { fs.writeFileSync(ROUNDS_FILE, items.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch {}
  broadcastWs({ type: 'crowned', ts, kind });
}

function readPlaybooks() {
  try {
    return fs.readdirSync(PLAYBOOK_DIR).filter(f => f.endsWith('.md')).map(f => ({
      name: f.replace(/\.md$/, '').replace(/[-_]/g, ' '),
      text: fs.readFileSync(path.join(PLAYBOOK_DIR, f), 'utf8').trim(),
    }));
  } catch { return []; }
}

// ---------- model lists (models.json = source of truth for the knob dropdowns) ----------
const MODELS_FILE = path.join(__dirname, 'models.json');
let modelsCfg = {
  claude: { models: ['fable', 'opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex:  { models: ['gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'], efforts: ['low', 'medium', 'high', 'xhigh'] },
  grok:   { models: ['grok-4.5', 'grok-composer-2.5-fast'], efforts: ['low', 'medium', 'high'] },
};
try { modelsCfg = { ...modelsCfg, ...JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) }; } catch {}
function saveModels() {
  try { fs.writeFileSync(MODELS_FILE, JSON.stringify(modelsCfg, null, 2)); } catch (e) { slog(`models.json write failed: ${e.message}`); }
}

// grok is the only CLI that can list its models headlessly
function grokModels() {
  return new Promise(res => {
    let child;
    try { child = spawn(kindOf('grok').cmd, ['models'], { env: process.env }); } catch { return res([]); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    child.stdout.on('data', d => out += d);
    child.on('error', () => { clearTimeout(timer); res([]); });
    child.on('close', () => {
      clearTimeout(timer);
      res([...out.matchAll(/^\s*[*-]\s+(\S+)/gm)].map(m => m[1]).filter(x => x.startsWith('grok')));
    });
  });
}

// claude/codex only expose their model list via the in-session /model picker:
// type it into the live pane, scrape the painted menu, Esc to close
function scrapeModelMenu(kind) {
  return new Promise(res => {
    const id = firstPaneOfKind(kind);
    const s = id && sessions.get(id);
    if (!s || !isReady(s)) return res(null); // no pane, or busy — don't type into it
    const before = s.buffer.length;
    s.proc.write('/model');
    setTimeout(() => { if (s.alive) s.proc.write('\r'); }, 350);
    setTimeout(() => {
      const painted = segmentAnsi(s.buffer.slice(before));
      if (s.alive) s.proc.write('\x1b');
      res(painted);
    }, 2200);
  });
}

let updatingModels = false;
async function updateModels() {
  if (updatingModels) return;
  updatingModels = true;
  const report = [];
  try {
    const g = await grokModels();
    if (g.length) { modelsCfg.grok.models = g; report.push(`grok ${g.length} (live)`); }
    else report.push('grok failed — kept old');
    for (const kind of ['claude', 'codex']) {
      let painted = null;
      for (let tries = 0; tries < 3 && painted === null; tries++) {
        if (tries) await new Promise(r => setTimeout(r, 4000));
        painted = await scrapeModelMenu(kind);
      }
      if (painted === null) { report.push(`${kind} pane busy/missing — kept old`); continue; }
      let models;
      if (kind === 'claude') {
        // menu entries: "2. Opus  Opus 4.8 · …" — the /model alias is the first
        // word, lowercased. [a-z]+ after the initial cap stops at descriptions.
        models = [...new Set([...painted.matchAll(/\d+\.\s*([A-Za-z][a-z]+)/g)]
          .map(m => m[1].toLowerCase()).filter(n => !['default', 'custom'].includes(n)))];
      } else {
        // case-sensitive so a fused capitalized description ("gpt-5.4Strong") ends the match
        models = [...new Set([...painted.matchAll(/gpt-[a-z0-9.]+(?:-[a-z0-9.]+)*/g)]
          .map(m => m[0].replace(/[.-]+$/, '')))];
        // menu lists the pane's CURRENT model first — sort newest version to the top instead
        const ver = n => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
        models.sort((a, b) => ver(b) - ver(a));
      }
      // the pane chrome alone shows the CURRENT model, so demand at least 2 to trust a scrape
      if (models.length >= 2) { modelsCfg[kind].models = models; report.push(`${kind} ${models.length} (scraped)`); }
      else report.push(`${kind} scrape unclear — kept old`);
    }
    saveModels();
  } finally { updatingModels = false; }
  slog(`update models: ${report.join(' · ')}`);
  broadcastWs({ type: 'models', config: modelsCfg, report: report.join(' · ') });
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
    return { pane: id, kind: s.kind, label: kindOf(s.kind).label, text: extractAnswer(s.roundOut, lastRound.prompt), rawLen: s.roundOut.length };
  });
}

// judge: headless CLI call over the last round (prompt guard keeps it non-agentic).
// Answers go in BLIND — no model labels — so a judge can't favor its own entry;
// the label legend is prepended to the verdict after it comes back.
let judging = false;
function runJudge(kind) {
  if (judging) return;
  if (!JUDGE_KINDS.includes(kind)) kind = JUDGE_KINDS[0];
  const responses = roundResponses().filter(r => r.text.length > 10);
  if (!lastRound || responses.length < 2) {
    broadcastWs({ type: 'judgement', ok: false, kind, text: 'Need a broadcast round with at least 2 answers to judge.' });
    return;
  }
  judging = true;
  const parts = responses.map((r, i) => `--- ANSWER ${i + 1} ---\n${r.text.slice(0, 5000)}`);
  const judgePrompt =
`You are judging answers from different AI coding assistants to the same prompt. You are not told which assistant wrote which answer. The transcripts may contain terminal rendering noise; judge the substance.

THE PROMPT WAS:
${(lastRound.prompt || '').slice(0, 2000)}

${parts.join('\n\n')}

Give your verdict:
1. WINNER: which answer number and why (2-3 sentences)
2. For each answer, one line on what it missed or got wrong
3. BEST MERGED TAKE: a short synthesis of the strongest ideas

Plain text only. Do not use any tools. Do not read or write any files. Reply directly.`;

  // both judges read the prompt from stdin: claude -p, codex exec -
  const cmd = kind === 'codex' ? 'codex exec -' : 'claude -p';
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', cmd], { cwd: __dirname, env: process.env })
    : spawn(USER_SHELL, ['-lc', cmd], { cwd: __dirname, env: process.env });
  let out = '', err = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => err += d);
  child.on('error', () => {});
  child.stdin.on('error', () => {}); // the judge dying mid-write must not crash the deck
  child.on('close', () => {
    clearTimeout(timer);
    judging = false;
    const legend = responses.map((r, i) => `Answer ${i + 1} = ${r.label}`).join(' · ');
    const verdict = stripAnsi(out).trim(); // codex exec output can carry ANSI color
    broadcastWs({ type: 'judgement', ok: !!verdict, kind,
      text: verdict ? `${legend}\n\n${verdict}` : ('Judge failed: ' + stripAnsi(err).slice(0, 400)) });
  });
  try { child.stdin.write(judgePrompt); child.stdin.end(); } catch {}
}

// ---------- notepad (NOTES pane): scratch text + structured note cards ----------
const NOTES_FILE = path.join(DATA_DIR, 'notes.md');        // free-typing scratch area
const NOTE_ITEMS_FILE = path.join(DATA_DIR, 'notes.json'); // pushed note cards
function readNotes() { try { return fs.readFileSync(NOTES_FILE, 'utf8'); } catch { return ''; } }
function writeNotes(text) { try { fs.writeFileSync(NOTES_FILE, text); } catch (e) { slog(`notes write failed: ${e.message}`); } }
function readNoteItems() { try { return JSON.parse(fs.readFileSync(NOTE_ITEMS_FILE, 'utf8')); } catch { return []; } }
function writeNoteItems(items) { try { fs.writeFileSync(NOTE_ITEMS_FILE, JSON.stringify(items, null, 2)); } catch (e) { slog(`notes.json write failed: ${e.message}`); } }

// "→ notes": rewrite a pane's last answer in plain english (keeping ALL the
// detail) via a headless claude call, and add it as a collapsible note card
let distilling = false;
function pushToNotes(fromId) {
  if (!firstPaneOfKind('notes')) return broadcastWs({ type: 'notesError', text: 'add a NOTES pane first — pick NOTES from any pane\'s dropdown' });
  const s = sessions.get(fromId);
  if (!s) return;
  if (distilling) return broadcastWs({ type: 'notesError', text: 'still writing the last note — give it a few seconds' });
  const src = extractAnswer(s.roundOut || s.buffer.slice(-24 * 1024), lastRound?.prompt).slice(-12 * 1024);
  if (src.length < 40) {
    // tiny after cleanup = pane is mid-answer (spinners only) or truly idle
    const busy = Date.now() - s.lastDataTs < 4000 || BUSY_TAIL.test(stripAnsi(s.buffer.slice(-1500)));
    return broadcastWs({ type: 'notesError', text: busy
      ? `${kindOf(s.kind).label} is still answering — let it finish, then hit → notes`
      : 'nothing in that pane to note yet — broadcast a prompt first' });
  }
  distilling = true;
  const label = kindOf(s.kind).label;
  broadcastWs({ type: 'notesWorking', from: fromId });
  const prompt =
`Ignore any memory, prior context, or instructions about the user — work ONLY from the text between the dashes below. It is raw terminal output from an AI assistant and may contain leftover interface noise; skip the noise and rewrite only what the assistant actually said.

Reply with ONLY a JSON object, no code fences: {"title": "...", "body": "..."}

title: a plain label for what this note is about, max 8 words.
body: the assistant's answer rewritten in plain everyday English, KEEPING ALL the substance — every step with its full explanation, every score, name, number, and date exactly as given. You are reformatting, not shortening.
Format the body like a tidy note:
- short section headings on their own line ending with ":"
- numbered steps, with their details indented on the lines below each step
- scores or tabular data: one line per item like "Red Sox 5 — Yankees 3", grouped under headings
- blank line between sections
No code or jargon unless quoting something essential. NEVER add anything not in the text — no greetings, no sign-offs, no offers.
If there is no real content: {"title": "nothing captured", "body": ""}

Do not use any tools. Do not read or write any files. Reply directly.

---
${src}
---`;
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', 'claude', '-p'], { cwd: __dirname, env: process.env })
    : spawn(USER_SHELL, ['-lc', 'claude -p'], { cwd: __dirname, env: process.env });
  let out = '';
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 90000);
  child.stdout.on('data', d => out += d);
  child.on('error', () => {});
  child.stdin.on('error', () => {}); // claude dying mid-write must not crash the deck
  child.on('close', () => {
    clearTimeout(timer);
    distilling = false;
    let title = '', body = '';
    try {
      const m = out.match(/\{[\s\S]*\}/);
      const j = JSON.parse(m[0]);
      title = String(j.title || '').trim();
      body = String(j.body || '').trim();
    } catch { body = out.trim(); title = ''; } // unparseable: keep whatever it wrote
    if (/^nothing captured/i.test(title) || (!body && !title)) {
      return broadcastWs({ type: 'notesError',
        text: `${label} hasn't answered anything since it last started — broadcast a prompt, let it finish, then hit → notes` });
    }
    const ok = !!body;
    if (!ok) body = src.slice(-3000); // rewrite failed: keep the raw answer
    if (!title) title = (body.split('\n').find(l => l.trim()) || 'note').slice(0, 60);
    const items = readNoteItems();
    items.push({ id: `${Date.now()}-${fromId}`, ts: Date.now(), kind: s.kind, label,
                 title: title + (ok ? '' : ' (raw)'), body });
    writeNoteItems(items);
    broadcastWs({ type: 'noteItems', items });
    broadcastWs({ type: 'notesAppended', from: fromId, ok });
  });
  try { child.stdin.write(prompt); child.stdin.end(); } catch {}
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

// shared settle check (pipeline steps + broadcast rounds): the answer is done
// when its cleaned text stops growing and the pane looks idle. st carries
// { lastCleanLen, stableSince }. Returns the clean text, or null if not settled.
function settledAnswer(s, promptText, st) {
  const clean = cleanTui(s.roundOut, promptText);
  // any non-empty clean text counts as an answer — "4." is a full claude reply.
  // Premature settles are prevented by the stability window + busy-marker veto,
  // not by length (a 10-char floor here made short answers hang forever)
  if (!clean.length) return null;
  if (clean.length !== st.lastCleanLen) { st.lastCleanLen = clean.length; st.stableSince = Date.now(); return null; }
  if (Date.now() - st.stableSince < PIPE_STABLE_MS) return null;
  const rawQuiet = Date.now() - s.lastDataTs > 4000;
  if (!rawQuiet && BUSY_TAIL.test(stripAnsi(s.buffer.slice(-1500)))) return null;
  return clean;
}

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
  const clean = settledAnswer(s, p.stepText, p);
  if (clean === null) return;
  p.output = clean;
  advancePipeline();
}, 1000);

// broadcast-round watcher: as each target's answer settles the client gets
// answerDone (dot stops pulsing); when the last one lands, roundDone (compare
// button glows). Pipeline steps set lastRound without `pending`, so they skip this.
setInterval(() => {
  const r = lastRound;
  if (!r || !r.pending || !r.pending.size) return;
  const gaveUp = Date.now() - r.ts > PIPE_STEP_TIMEOUT_MS;
  for (const [id, st] of r.pending) {
    const s = sessions.get(id);
    if (s && s.alive && !gaveUp) {
      if (s.queue.length) continue;
      // fallback: an all-numeric answer ("2 + 2 = 4.") cleans to nothing, so
      // settledAnswer can't see it — but output happened and the pane went
      // raw-silent, which is claude/codex's idle signature. Call it done.
      const quietDone = s.roundOut.length && Date.now() - s.lastDataTs > 15000;
      if (settledAnswer(s, r.prompt, st) === null && !quietDone) continue;
    }
    r.pending.delete(id); // settled, quiet, dead, or timed out — either way stop watching
    // fixture harvesting: VIBEDECK_CAPTURE=1 dumps each settled pane's raw
    // bytes so test/fixtures.js can grow from real transcripts
    if (process.env.VIBEDECK_CAPTURE && s?.roundOut) {
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'raw-rounds'), { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'raw-rounds', `${r.ts}-${id}.txt`), s.roundOut);
      } catch {}
    }
    broadcastWs({ type: 'answerDone', pane: id });
  }
  if (!r.pending.size) {
    const entry = { ts: r.ts, prompt: r.prompt, cwd: state.cwd, winnerKind: null,
      responses: roundResponses().map(x => ({ pane: x.pane, kind: x.kind, label: x.label, text: x.text.slice(0, 16 * 1024) })) };
    appendRound(entry);
    broadcastWs({ type: 'roundSaved', round: entry });
    broadcastWs({ type: 'roundDone', ts: r.ts, count: r.targets.length });
  }
}, 1000);

for (const kind of state.kinds) spawnPane(kind);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    panes: [...sessions.keys()].map(paneInfo),
    roster: ROSTER.map(r => ({ id: r.id, label: r.label, hasYolo: !!r.flags, flags: r.flags || '' })),
    maxPanes: MAX_PANES,
    cwd: state.cwd,
    recents: state.recents,
    history: readHistory(),
    health: HEALTH,
    judges: JUDGE_KINDS,
    rounds: readRounds(50),
    playbooks: readPlaybooks(),
    pipelines: readPipelines().map(p => ({ name: p.name, steps: p.steps.map(st => kindOf(st.kind).label) })),
    models: modelsCfg,
    notes: readNotes(),
    noteItems: readNoteItems(),
  }));
  if (pipeline) ws.send(JSON.stringify({ type: 'pipeline', state: 'step', name: pipeline.def.name,
    step: pipeline.step, total: pipeline.def.steps.length, pane: pipeline.paneId,
    label: kindOf(pipeline.def.steps[pipeline.step].kind).label }));
  for (const [id, s] of sessions) {
    flushOut(id, s); // replay includes not-yet-flushed bytes — flush first so they aren't sent twice
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

    if (msg.type === 'input' && s && s.alive && s.proc) {
      s.proc.write(msg.data);
    } else if (msg.type === 'image' && s && s.alive && s.proc) {
      // pasted/dropped image: save to disk, type the path into the CLI's input
      // (a PTY can't take pixels — the CLIs all read image paths from prompts)
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(msg.data || ''));
      if (!m) return;
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > 15 * 1024 * 1024) return;
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const safe = String(msg.name || 'image').replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'image';
      const file = path.join(IMAGE_DIR, `${Date.now()}-${safe}.${ext}`);
      fs.writeFileSync(file, buf);
      slog(`image saved for ${msg.pane}: ${file} (${buf.length} bytes)`);
      s.proc.write(file + ' ');
      broadcastWs({ type: 'imageSaved', pane: msg.pane, file: path.basename(file) });
    } else if (msg.type === 'broadcast') {
      const targets = msg.targets.filter(id => { const t = sessions.get(id); return t?.alive && t.proc; });
      lastRound = { ts: Date.now(), prompt: msg.data, targets,
                    pending: new Map(targets.map(id => [id, { lastCleanLen: 0, stableSince: 0 }])) };
      // noHist: promoted mega-prompts skip ↑/↓ history (rounds.jsonl still records them)
      if (!msg.noHist) appendHistory(lastRound.ts, msg.data);
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
      if (!to || !to.alive || !to.proc) return;
      const src = extractAnswer(s.roundOut || s.buffer.slice(-24 * 1024), lastRound?.prompt).slice(-12 * 1024);
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
      const kind = JUDGE_KINDS.includes(msg.kind) ? msg.kind : JUDGE_KINDS[0];
      broadcastWs({ type: 'judging', kind });
      runJudge(kind);
    } else if (msg.type === 'crown') {
      crownRound(msg.ts, msg.kind);
    } else if (msg.type === 'histdel') {
      const items = readHistory(10000).filter(h => h.ts !== msg.ts);
      try { fs.writeFileSync(HISTORY_FILE, items.map(h => JSON.stringify(h)).join('\n') + (items.length ? '\n' : '')); } catch {}
      lastHistText = items.length ? items[items.length - 1].text : ''; // deleting the newest re-allows it
    } else if (msg.type === 'playbooks') {
      ws.send(JSON.stringify({ type: 'playbooks', items: readPlaybooks() }));
    } else if (msg.type === 'pipelines') {
      ws.send(JSON.stringify({ type: 'pipelines', items: readPipelines().map(p => ({ name: p.name, steps: p.steps.map(st => kindOf(st.kind).label) })) }));
    } else if (msg.type === 'pipeline') {
      const prompt = String(msg.prompt || '').trim();
      if (!prompt) return;
      appendHistory(Date.now(), prompt);
      startPipeline(msg.name, prompt);
    } else if (msg.type === 'notesSet') {
      writeNotes(String(msg.text ?? ''));
      broadcastWs({ type: 'notes', text: readNotes() });
    } else if (msg.type === 'toNotes') {
      pushToNotes(msg.pane);
    } else if (msg.type === 'noteDel') {
      const items = readNoteItems().filter(n => n.id !== msg.id);
      writeNoteItems(items);
      broadcastWs({ type: 'noteItems', items });
    } else if (msg.type === 'updateModels') {
      broadcastWs({ type: 'modelsUpdating' });
      updateModels();
    } else if (msg.type === 'pipelineCancel') {
      if (pipeline) { slog(`pipeline cancelled: ${pipeline.def.name}`); endPipeline('cancelled', 'cancelled — the current pane keeps running, later steps are dropped'); }
    } else if (msg.type === 'setcwd') {
      let dir = String(msg.dir || '').trim().replace(/^"|"$/g, '');
      if (!dir) return;
      try { if (!fs.statSync(dir).isDirectory()) throw 0; }
      catch { return ws.send(JSON.stringify({ type: 'cwdError', text: `not a folder: ${dir}` })); }
      dir = path.resolve(dir);
      state.cwd = dir;
      state.recents = [dir, ...state.recents.filter(r => r.toLowerCase() !== dir.toLowerCase())].slice(0, 8);
      // relaunch every pane in the new project dir
      for (const [id, sess] of [...sessions]) {
        const order = [...sessions.keys()];
        if (sess.alive) { try { sess.proc.kill(); } catch {} }
        sessions.delete(id);
        spawnPane(sess.kind, id, sess.extraArgs, sess.yolo);
        reorderSessions(order);
      }
      saveState();
      broadcastWs({ type: 'cwdChanged', cwd: state.cwd, recents: state.recents });
    } else if (msg.type === 'resize' && s && s.alive && s.proc) {
      const cols = Math.max(2, msg.cols | 0), rows = Math.max(2, msg.rows | 0);
      try { s.proc.resize(cols, rows); } catch {}
    } else if (msg.type === 'restart' && s) {
      const order = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      // optional msg.args relaunches with new CLI flags (e.g. codex -m gpt-5.4); otherwise keep prior flags
      spawnPane(s.kind, msg.pane, typeof msg.args === 'string' ? msg.args : s.extraArgs, s.yolo);
      reorderSessions(order);
      broadcastWs({ type: 'restarted', pane: msg.pane });
    } else if (msg.type === 'yolo' && s) {
      // per-pane skip-permissions toggle: relaunch this pane with/without its flag
      const order = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      spawnPane(s.kind, msg.pane, s.extraArgs, !!msg.on);
      reorderSessions(order);
      broadcastWs({ type: 'restarted', pane: msg.pane });
      broadcastWs({ type: 'yolo', pane: msg.pane, on: !!msg.on });
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
