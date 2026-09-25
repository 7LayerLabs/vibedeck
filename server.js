// VibeDeck — one prompt, a deck of AI CLIs in live terminal panes
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');

const PORT = Number(process.env.VIBEDECK_PORT ?? 18801);
const USER_DATA = process.env.VIBEDECK_DATA_DIR || __dirname;
fs.mkdirSync(USER_DATA, {recursive:true});
const HOME = process.env.USERPROFILE || process.env.HOME;
const STATE_FILE = path.join(USER_DATA, 'state.json');
const LEGACY_PANES = path.join(USER_DATA, 'panes.json');
const DATA_DIR = path.join(USER_DATA, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const PLAYBOOK_DIR = path.join(USER_DATA, 'playbooks');
const PIPELINE_DIR = path.join(USER_DATA, 'pipelines');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PLAYBOOK_DIR, { recursive: true });
fs.mkdirSync(PIPELINE_DIR, { recursive: true });
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Seed editable examples into the writable profile when running a packaged app.
if(USER_DATA!==__dirname) for(const folder of ['playbooks','pipelines']) {
  for(const file of fs.readdirSync(path.join(__dirname,folder))) {
    const destination=path.join(USER_DATA,folder,file);
    if(!fs.existsSync(destination))fs.copyFileSync(path.join(__dirname,folder,file),destination);
  }
}

// The kinds of CLI a pane can run. Any kind can run in multiple panes at once.
// ready: the pane isn't accepting typed prompts until this paints (dialogs/init eat input).
// Patterns are space-elastic (\s*) because Ink paints sometimes swallow spaces.
const IS_WIN = process.platform === 'win32';
const NPM_BIN = path.join(process.env.APPDATA || '', 'npm');
// windows needs the npm .cmd shims / grok.exe path; mac & linux find them on PATH
const CLI = name => {
  if(!IS_WIN)return name;
  try {const found=spawnSync('where.exe',[name],{encoding:'utf8',windowsHide:true}).stdout?.trim().split(/\r?\n/).find(p=>/\.(cmd|exe)$/i.test(p));if(found)return found;} catch {}
  return path.join(NPM_BIN,`${name}.cmd`);
};
const USER_SHELL = process.env.SHELL || '/bin/zsh';
// Provider permission prompts remain enabled in every terminal.
const ROSTER = [
  { id: 'claude', label: 'CLAUDE', cmd: CLI('claude'), ready: /⏵⏵|Try\s*"|\?\s*for\s*shortcuts/ },
  { id: 'codex',  label: 'CODEX',  cmd: CLI('codex'), ready: /gpt-[\d.]|› / },
  { id: 'grok',   label: 'GROK',   cmd: IS_WIN ? path.join(HOME, '.grok', 'bin', 'grok.exe') : 'grok', ready: /grok-|Shift\+Tab/i },
  { id: 'shell',  label: 'SHELL',  cmd: IS_WIN ? 'powershell -NoLogo' : USER_SHELL, ready: IS_WIN ? /PS .*>/ : undefined },
  { id: 'notes',  label: 'NOTES' }, // PTY-less: a plain-english notepad pane
];
const DEFAULT_ACTIVE = ['claude', 'codex', 'grok'];
// Startup dialogs (folder trust) eat typed input, so queued prompts wait until they are answered.
const TRUST_DIALOG = /Quick\s*safety\s*check|Do\s*you\s*trust/i;
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
  // an empty deck (no folder chosen yet) must not forget which panes to open later
  if (sessions.size) state.kinds = [...sessions.values()].map(s => s.kind);
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
  return { id: r.id, label: r.label, ok, version: '', detail: ok ? '' : `${r.cmd} not found` };
});
slog(`cli health: ${HEALTH.map(h => `${h.id}=${h.ok ? 'ok' : 'MISSING'}`).join(' ')}`);
// versions are looked up after boot (each CLI takes a second or two) and pushed to the UI
function readVersions() {
  for (const h of HEALTH.filter(x => x.ok)) {
    const cmd = kindOf(h.id).cmd;
    const isCmd = IS_WIN && /\.cmd$/i.test(cmd);
    let child;
    try { child = spawn(isCmd ? 'cmd.exe' : cmd, isCmd ? ['/d', '/c', cmd, '--version'] : ['--version'], { windowsHide: true, env: process.env }); } catch { continue; }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    child.stdout.on('data', d => out += d);
    child.on('error', () => clearTimeout(timer));
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/\d+\.\d+\.\d+/);
      if (m) { h.version = m[0]; broadcastWs({ type: 'health', health: HEALTH }); }
    });
  }
}
setTimeout(readVersions, 1500);
// judge kinds with a reliable non-interactive mode (claude -p, codex exec).
// grok has no clean headless path — deliberately not offered.
const JUDGE_KINDS = HEALTH.filter(h => h.ok && ['claude', 'codex'].includes(h.id)).map(h => h.id);
if (!JUDGE_KINDS.length) JUDGE_KINDS.push('claude');

// ---------- server ----------
const app = express();
const sessionToken = require('node:crypto').randomBytes(32).toString('hex');
const access = require('./lib/local-access').localAccess(sessionToken,()=>server.address()?.port);
app.use(access.middleware);
// no-cache so a plain reload always gets the current UI after an upgrade
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders: res => res.set('Cache-Control', 'no-cache'),
}));
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/addon-webgl', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-webgl')));
app.use('/vendor/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource-variable', 'inter', 'files')));
app.use('/vendor/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource-variable', 'jetbrains-mono', 'files')));

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

// Localhost only. HTTP and WebSocket clients must authenticate to this launch.
const server = app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/session?token=${sessionToken}`;
  if(process.send) process.send({type:'ready',url}); else console.log(`Open VibeDeck: ${url}`);
});
const wss = new WebSocketServer({ server, maxPayload: 22*1024*1024, verifyClient: info => access.valid(info.req) && !!info.req.headers.origin });

const {PipelineRunner,validatePipeline,executeStage}=require('./lib/pipeline-runner');
const {Connections,executeApiStage}=require('./lib/api-connections');
const vaultRequests=new Map();
function vault(action,id,key){
  if(!process.env.VIBEDECK_VAULT || !process.send)return Promise.reject(Error('Encrypted key storage is available in the desktop app. Use a session-only key here.'));
  const requestId=require('node:crypto').randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{vaultRequests.delete(requestId);reject(Error('Secure key storage timed out.'));},15000);
    vaultRequests.set(requestId,{resolve,reject,timer});process.send({type:'vault',requestId,action,id,key});
  });
}
process.on('message',message=>{if(message?.type!=='vaultResult')return;const request=vaultRequests.get(message.requestId);if(!request)return;clearTimeout(request.timer);vaultRequests.delete(message.requestId);message.error?request.reject(Error(message.error)):request.resolve(message.result);});
const connections=new Connections(path.join(DATA_DIR,'connections.json'),vault);

const CUSTOM_PIPELINES_FILE=path.join(DATA_DIR,'custom-pipelines.json');
let customDefinitions=[];
try {customDefinitions=JSON.parse(fs.readFileSync(CUSTOM_PIPELINES_FILE,'utf8')).map(validatePipeline);}catch{}
let customStatus={state:'idle',outputs:[]};

// Finished pipeline runs (done, stopped or failed with some output) for the History page.
const RUNS_FILE=path.join(DATA_DIR,'pipeline-runs.jsonl');
const RUNS_MAX=100;
function readRuns(){
  try {return fs.readFileSync(RUNS_FILE,'utf8').trim().split('\n').map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean).slice(-RUNS_MAX);}catch{return [];}
}
function saveRun(status){
  const entry={id:status.id,ts:status.startedAt,finishedAt:Date.now(),name:status.name,request:status.request,cwd:status.cwd,state:status.state,error:status.state==='error'?status.text:'',
    steps:status.steps,outputs:status.outputs.map(o=>({kind:o.kind,role:o.role,model:o.model,ms:o.ms,edited:!!o.edited,text:o.text.slice(0,64*1024)}))};
  const items=readRuns().filter(r=>r.id!==entry.id).slice(-(RUNS_MAX-1));items.push(entry);
  try {fs.writeFileSync(RUNS_FILE,items.map(r=>JSON.stringify(r)).join('\n')+'\n');} catch(e){slog(`runs write failed: ${e.message}`);}
  broadcastWs({type:'pipelineRunSaved',run:entry});
}
const API_TIMEOUT_MS=10*60000;
const customRunner=new PipelineRunner({
  resolveCommand:kind=>kindOf(kind)?.cmd||CLI(kind),
  execute:args=>{
    if(args.step.kind!=='api')return executeStage(args);
    args.onActivity('Waiting for the API connection to reply');
    return executeApiStage({...args,connections,timeoutMs:API_TIMEOUT_MS});
  },
  emit:status=>{
    if(status.type==='activity')return broadcastWs({type:'pipelineActivity',id:status.id,index:status.index,activity:status.activity});
    customStatus=status;broadcastWs({type:'customPipelineStatus',...status});
    if(status.state!==customRunner.lastSavedState && ['done','cancelled','error'].includes(status.state) && (status.outputs.length || status.state==='error')){saveRun(status);}
    customRunner.lastSavedState=status.state;
    if(['done','cancelled','error'].includes(status.state))slog(`pipeline ${status.name}: ${status.state}${status.text?' '+status.text:''}`);
  },
});

// Starter pipelines shipped in pipelines/*.json (new-format definitions only).
function readTemplates(){
  const out=[];
  for(const dir of [PIPELINE_DIR,path.join(__dirname,'pipelines')]){
    try {for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))){
      try {const def=validatePipeline(JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));if(!out.some(t=>t.name===def.name))out.push(def);}catch{}
    }}catch{}
  }
  return out;
}

// "Browse" asks the desktop shell for a native folder dialog; browser mode types a path instead.
const folderRequests=new Map();
function pickFolder(){
  if(!process.send)return Promise.resolve(null);
  const requestId=require('node:crypto').randomUUID();
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{folderRequests.delete(requestId);resolve(null);},10*60000);
    folderRequests.set(requestId,dir=>{clearTimeout(timer);resolve(dir);});
    process.send({type:'pickFolder',requestId,defaultPath:state.cwd});
  });
}
process.on('message',message=>{if(message?.type!=='pickFolderResult')return;const done=folderRequests.get(message.requestId);if(done){folderRequests.delete(message.requestId);done(typeof message.dir==='string'?message.dir:null);}});
app.get('/api/desktop-health',(req,res)=>res.json({ok:true,version:require('./package.json').version,providers:HEALTH}));

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
  yolo = false; // Release builds retain the provider permission checks.
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

// Screens where a CLI is blocked on a question only the user should answer.
// The UI shows a card over the pane instead of leaving raw TUI text to decode.
const WAITING = [
  { kinds: ['claude'], test: t => TRUST_DIALOG.test(t), title: 'Claude is asking to trust this folder',
    reason: 'Click into the pane, pick "Yes, I trust this folder" with the arrow keys, then press Enter. Claude asks once per folder.' },
  { kinds: ['codex'], test: t => /Update\s*available/i.test(t) && /Press\s*enter\s*to\s*continue/i.test(t), title: 'Codex has an update',
    reason: 'Pick "Update now" or "Skip" in the pane with the arrow keys, then press Enter.' },
  { kinds: ['claude', 'codex', 'grok'], test: t => /Select\s*login\s*method|Sign\s*in\s*with\s*ChatGPT|Please\s*run\s*\/login|not\s*logged\s*in/i.test(t), title: 'Sign-in needed',
    reason: 'This CLI is not signed in. Follow the sign-in steps in the pane, or use Connections to start the provider login.' },
];
setInterval(() => {
  for (const [id, s] of sessions) {
    if (!s.proc || !s.alive) { if (s.waiting) { s.waiting = null; broadcastWs({ type: 'paneWaiting', pane: id, reason: '' }); } continue; }
    const tail = stripAnsi(s.buffer.slice(-2500));
    const hit = WAITING.find(w => w.kinds.includes(s.kind) && w.test(tail));
    const key = hit ? hit.title : null;
    if (key !== (s.waiting || null)) {
      s.waiting = key;
      broadcastWs({ type: 'paneWaiting', pane: id, title: hit?.title || '', reason: hit?.reason || '' });
    }
  }
}, 1000);

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
const MODELS_FILE = path.join(USER_DATA, 'models.json');
let modelsCfg = {
  claude: { models: ['fable', 'opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex:  { models: ['gpt-6-astra', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'], efforts: ['low', 'medium', 'high', 'xhigh'] },
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

const PIPE_STABLE_MS = 8000;
const PIPE_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const BUSY_TAIL = /escs+tos+interrupt/i;

// shared settle check (broadcast rounds): the answer is done
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
    if(!s?.alive || gaveUp){
      r.pending.delete(id);r.failed=true;
      broadcastWs({type:'answerFailed',pane:id,text:gaveUp?'Response timed out.':'Terminal exited before completing.'});
      continue;
    }
    r.pending.delete(id);
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
    broadcastWs({ type: r.failed?'roundFailed':'roundDone', ts: r.ts, count: r.targets.length });
  }
}, 1000);

// Panes only open once a real project folder is chosen: starting AI CLIs in the
// home folder would ask them to trust (and work in) everything the user owns.
const needsFolder = () => !state.cwd || path.resolve(state.cwd).toLowerCase() === path.resolve(HOME).toLowerCase();
function spawnSavedPanes() {
  for (const kind of state.kinds) {
    if (sessions.size >= MAX_PANES) break;
    if (kind==='notes' || kind==='shell' || HEALTH.find(h=>h.id===kind)?.ok) {
      const id = spawnPane(kind);
      broadcastWs({ type: 'paneAdded', pane: paneInfo(id) });
    }
  }
}
if(!process.env.VIBEDECK_NO_PANES && !needsFolder()) spawnSavedPanes();

// "-> sidecar": file a pane's last answer into Sidecar (localhost:3010) as a formatted doc.
function pushToSidecar(fromId) {
  const s = sessions.get(fromId);
  if (!s) return;
  const src = extractAnswer(s.roundOut || s.buffer.slice(-24 * 1024), lastRound?.prompt).slice(-12 * 1024);
  const label = kindOf(s.kind).label;
  if (src.length < 40) {
    const busy = Date.now() - s.lastDataTs < 4000 || BUSY_TAIL.test(stripAnsi(s.buffer.slice(-1500)));
    return broadcastWs({ type: 'notice', text: busy ? `${label} is still answering. Let it finish, then send it to Sidecar.` : 'Nothing in that pane to file yet. Broadcast a prompt first.' });
  }
  const title = (lastRound?.prompt || `${label} answer`).replace(/\s+/g, ' ').trim().slice(0, 60);
  fetch('http://localhost:3010/filedoc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ md: src, title, source: label }) })
    .then(r => broadcastWs({ type: 'notice', text: r.ok ? `${label}'s answer was filed to Sidecar.` : 'Sidecar rejected the answer. Is it up to date?' }))
    .catch(() => broadcastWs({ type: 'notice', text: 'Sidecar is not running. Start it, then try again.' }));
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'init',
    customDefinitions, customStatus, connections:connections.list(), secureKeyStorage:!!process.env.VIBEDECK_VAULT,
    templates: readTemplates(), runs: readRuns(), desktop: !!process.send, home: HOME, needsFolder: needsFolder(),
    version: require('./package.json').version,
    panes: [...sessions.keys()].map(paneInfo),
    roster: ROSTER.map(r => ({ id: r.id, label: r.label, hasYolo: false, flags: '' })),
    maxPanes: MAX_PANES,
    cwd: state.cwd,
    recents: state.recents,
    history: readHistory(),
    health: HEALTH,
    judges: JUDGE_KINDS,
    rounds: readRounds(50),
    playbooks: readPlaybooks(),
    models: modelsCfg,
    notes: readNotes(),
    noteItems: readNoteItems(),
  }));
  for (const [id, s] of sessions) {
    flushOut(id, s); // replay includes not-yet-flushed bytes — flush first so they aren't sent twice
    ws.send(JSON.stringify({ type: 'data', pane: id, data: s.buffer, replay: true }));
    if (!s.alive) ws.send(JSON.stringify({ type: 'exit', pane: id, code: null }));
    else if (s.waiting) { const w = WAITING.find(x => x.title === s.waiting); if (w) ws.send(JSON.stringify({ type: 'paneWaiting', pane: id, title: w.title, reason: w.reason })); }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handleMessage(msg, ws); } catch (e) { slog(`handler error (${msg.type}): ${e.stack}`); }
  });

  function handleMessage(msg, ws) {
    if(!msg || typeof msg!=='object')return;
    const s = sessions.get(msg.pane);
    const reply=obj=>{if(ws.readyState===1)ws.send(JSON.stringify(obj));};
    const notice=text=>reply({type:'notice',text});
    if(typeof msg.type!=='string')return;
    if(msg.type==='connectionTest'){
      if(ws.connectionTest)return notice('A connection test is already running.');
      const task=executeApiStage({step:{connectionId:msg.id},prompt:'Reply with a short greeting to confirm this connection works.',connections,timeoutMs:30000});
      ws.connectionTest=task;
      const cancel=()=>task.cancel();ws.once('close',cancel);
      task.promise.then(answer=>reply({type:'connectionTestResult',id:msg.id,ok:true,text:'Connected. The model replied: '+answer.slice(0,500)}))
        .catch(error=>reply({type:'connectionTestResult',id:msg.id,ok:false,text:error.message}))
        .finally(()=>{ws.connectionTest=null;ws.off('close',cancel);});
      return;
    }
    if(msg.type==='cliSignIn'){
      const args={claude:'auth login',codex:'login',grok:'login'}[msg.kind];
      if(!args)return;
      if(needsFolder())return notice('Choose a project folder first. Sign-in opens in a terminal pane.');
      if(sessions.size>=MAX_PANES)return notice('Close a terminal pane first. Sign-in opens in a new pane.');
      if(!HEALTH.find(h=>h.id===msg.kind)?.ok)return notice(`Install the ${msg.kind} CLI first, then restart VibeDeck.`);
      const id=spawnPane(msg.kind,undefined,args);saveState();broadcastWs({type:'paneAdded',pane:paneInfo(id)});
      return reply({type:'cliSignInOpened',pane:id});
    }
    if(['connectionSave','connectionRemove'].includes(msg.type)){
      if(customRunner.active)return notice('Finish or stop the pipeline before changing connections.');
      const operation=msg.type==='connectionSave'?connections.save(msg.connection):connections.remove(msg.id);
      operation.then(record=>{broadcastWs({type:'connections',items:connections.list(),text:msg.type==='connectionSave'?'Connection saved.':'Connection removed.'});if(record)reply({type:'connectionSaved',id:record.id});})
        .catch(error=>reply({type:'connectionError',text:error.message}));
      return;
    }
    if(msg.type==='customPipelineSave'||msg.type==='customPipelineDelete'){
      try {
        if(msg.type==='customPipelineSave'){const def=validatePipeline(msg.definition);customDefinitions=[...customDefinitions.filter(p=>p.name!==def.name),def].slice(-30);}
        else customDefinitions=customDefinitions.filter(p=>p.name!==msg.name);
        fs.writeFileSync(CUSTOM_PIPELINES_FILE,JSON.stringify(customDefinitions,null,2));
        broadcastWs({type:'customDefinitions',items:customDefinitions,saved:msg.type==='customPipelineSave'?String(msg.definition?.name||'').trim():''});
      }catch(e){reply({type:'customPipelineError',text:e.message});}
      return;
    }
    if(msg.type==='pickFolder'){
      pickFolder().then(dir=>reply({type:'folderPicked',dir:dir||''}));
      return;
    }
    if(msg.type.startsWith('customPipeline')){
      try {
        if(msg.type==='customPipelineStart'){
          if(needsFolder() && msg.definition?.steps?.some(step=>step.kind!=='api'))throw Error('Choose a project folder first. CLI stages work inside that folder.');
          if(lastRound?.pending?.size)throw Error('Wait for the current broadcast round to finish first.');
          const missing=(msg.definition?.steps||[]).find(step=>step.kind!=='api' && HEALTH.find(h=>h.id===step.kind) && !HEALTH.find(h=>h.id===step.kind).ok);
          if(missing)throw Error(`The ${missing.kind} CLI is not installed. Install it or pick another provider for that stage.`);
          customRunner.start(msg.definition,msg.prompt,state.cwd,{autoApprove:!!msg.autoApprove});
        }
        else if(msg.type==='customPipelineResume')customRunner.resume({note:msg.note,editedOutput:msg.editedOutput});
        else if(msg.type==='customPipelineRetry')customRunner.retry({note:msg.note});
        else if(msg.type==='customPipelineAuto')customRunner.setAutoApprove(msg.on);
        else if(msg.type==='customPipelineDismiss')customRunner.dismiss();
        else if(msg.type==='customPipelineCancel')customRunner.cancel();
      }catch(e){reply({type:'customPipelineError',text:e.message});}
      return;
    }
    // A running pipeline works in the project folder, so nothing may move the folder or
    // fire competing prompts at it. Typing into a pane stays allowed.
    if(customRunner.active && ['broadcast','relay','setcwd','replace'].includes(msg.type))return notice('A pipeline is running in this folder. Stop it or let it finish first.');

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
      if(!Array.isArray(msg.targets)||typeof msg.data!=='string'||!msg.data.trim()||msg.data.length>32000)return;
      if(lastRound?.pending?.size)return notice('Wait for the current round to finish, or stop it first.');
      const targets = msg.targets.filter(id => { const t = sessions.get(id); return t?.alive && t.proc; });
      if(!targets.length)return notice('Turn on broadcast for at least one live terminal first.');
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
    } else if (msg.type === 'stopRound') {
      if (lastRound?.pending?.size) {
        for (const id of lastRound.pending.keys()) { const t = sessions.get(id); if (t) t.queue = []; }
        lastRound.pending.clear();
        broadcastWs({ type: 'roundStopped' });
      }
    } else if (msg.type === 'notesSet') {
      writeNotes(String(msg.text ?? ''));
      broadcastWs({ type: 'notes', text: readNotes() });
    } else if (msg.type === 'toNotes') {
      pushToNotes(msg.pane);
    } else if (msg.type === 'toSidecar') {
      pushToSidecar(msg.pane);
    } else if (msg.type === 'noteDel') {
      const items = readNoteItems().filter(n => n.id !== msg.id);
      writeNoteItems(items);
      broadcastWs({ type: 'noteItems', items });
    } else if (msg.type === 'updateModels') {
      broadcastWs({ type: 'modelsUpdating' });
      updateModels();
    } else if (msg.type === 'setcwd') {
      let dir = String(msg.dir || '').trim().replace(/^"|"$/g, '');
      if (!dir) return;
      try { if (!fs.statSync(dir).isDirectory()) throw 0; }
      catch { return notice(`That folder does not exist: ${dir}`); }
      dir = path.resolve(dir);
      if (dir.toLowerCase() === path.resolve(HOME).toLowerCase()) return notice('Pick a project folder, not your whole user folder.');
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
      if (!sessions.size && !process.env.VIBEDECK_NO_PANES) spawnSavedPanes();
      saveState();
      broadcastWs({ type: 'cwdChanged', cwd: state.cwd, recents: state.recents, needsFolder: needsFolder() });
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

function shutdown() {
  for(const s of sessions.values()) { try { s.proc?.kill(); } catch {} }
  if(customRunner) customRunner.cancel();
  server.close();
  setTimeout(()=>process.exit(0),300).unref();
}
process.on('message', msg=>{if(msg?.type==='shutdown')shutdown();});
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
process.on('disconnect',shutdown);
