// VibeDeck — one prompt, a deck of AI CLIs in live terminal panes
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const pty = require('@lydell/node-pty');
const { childEnv } = require('./lib/env');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

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
// Matched on the dialogs' own option lines so ordinary conversation text can't trigger it.
// Claude: "Quick safety check ... Yes, I trust this folder"; Codex: "1. Trust and continue".
const TRUST_DIALOG = /Quick\s*safety\s*check|Yes,\s*I\s*trust\s*this\s*folder|Trust\s*and\s*continue/i;
// Any numbered choice menu with a highlighted option ("› 1. Update now", "❯ 2. Opus 5.5") means the
// CLI is asking the user something (update, new-model offer, model picker). Typed prompts and Enter
// presses would answer it, so nothing is sent to a pane while one is on screen.
// Claude and Codex also echo the user's own sent prompts with the same pointer ("❯ 1. Fix the header"),
// so a line that is just the start of a recent prompt is not a menu.
const MENU_LINE = /^\s*[›❯>]\s*(\d+\.\s+\S.*)$/;
let recentPromptCache = { at: 0, items: [] };
function menuOpen(text) {
  if (!text.includes('.')) return false;
  if (Date.now() - recentPromptCache.at > 3000) recentPromptCache = { at: Date.now(), items: readHistory(20).map(h => h.text) };
  const recent = [lastRound?.prompt, ...recentPromptCache.items].filter(Boolean).map(p => p.replace(/\s+/g, ' ').trim());
  return text.split('\n').some(line => {
    const m = line.match(MENU_LINE);
    if (!m) return false;
    const option = m[1].replace(/\s+/g, ' ').trim();
    return !recent.some(p => p.startsWith(option.slice(0, 40)) || option.startsWith(p.slice(0, 40)));
  });
}
const MENU_OPEN = { test: menuOpen };
const questionOnScreen = s => { const t = screenText(s); return TRUST_DIALOG.test(t) || menuOpen(t); };
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
    try { child = spawn(isCmd ? 'cmd.exe' : cmd, isCmd ? ['/d', '/c', cmd, '--version'] : ['--version'], { windowsHide: true, env: childEnv() }); } catch { continue; }
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

// ---------- plan usage meters (lib/limits.js): what each CLI reports about its own limits ----------
const limitsLib = require('./lib/limits');
const usage = { claude: null, codex: null, grok: null, checkedAt: {} };
let claudeUsageBusy = false, claudeUsageAt = 0;
function refreshClaudeUsage() {
  if (claudeUsageBusy || !HEALTH.find(h => h.id === 'claude')?.ok) return;
  claudeUsageBusy = true; claudeUsageAt = Date.now();
  limitsLib.claudeUsage({ command: kindOf('claude').cmd, env: childEnv() }).then(r => {
    claudeUsageBusy = false;
    if (r) { usage.claude = r; usage.checkedAt.claude = Date.now(); broadcastWs({ type: 'usage', usage }); }
  });
}
function refreshLocalUsage() {
  try { usage.codex = HEALTH.find(h => h.id === 'codex')?.ok ? limitsLib.codexUsage() : null; usage.checkedAt.codex = Date.now(); } catch {}
  try { usage.grok = HEALTH.find(h => h.id === 'grok')?.ok ? limitsLib.grokUsage() : null; usage.checkedAt.grok = Date.now(); } catch {}
  broadcastWs({ type: 'usage', usage });
}
// after a round or pipeline run finishes, refresh soon (Claude at most once a minute)
function usageChanged() {
  setTimeout(refreshLocalUsage, 3000);
  if (Date.now() - claudeUsageAt > 60000) setTimeout(refreshClaudeUsage, 5000);
}
setTimeout(refreshLocalUsage, 3000);
setTimeout(refreshClaudeUsage, 4000);
setInterval(refreshLocalUsage, 60000);
setInterval(refreshClaudeUsage, 5 * 60000);
// Grok lists its models headlessly, so its list and default stay current without any clicks
setTimeout(async () => {
  if (!HEALTH.find(h => h.id === 'grok')?.ok) return;
  const g = await grokModels();
  if (g.length) { setModels('grok', g, false); broadcastWs({ type: 'models', config: modelsCfg, report: 'Grok list checked', quiet: true }); }
}, 2500);
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
  const entry={id:status.id,ts:status.startedAt,finishedAt:Date.now(),name:status.name,request:status.request,cwd:status.cwd,state:status.state,error:status.state==='error'?status.text:'',changes:status.changes||null,
    steps:status.steps,outputs:status.outputs.map(o=>({kind:o.kind,role:o.role,model:o.model,effort:o.effort,ranOn:o.ranOn,ms:o.ms,edited:!!o.edited,text:o.text.slice(0,64*1024)}))};
  const items=readRuns().filter(r=>r.id!==entry.id).slice(-(RUNS_MAX-1));items.push(entry);
  try {fs.writeFileSync(RUNS_FILE,items.map(r=>JSON.stringify(r)).join('\n')+'\n');} catch(e){slog(`runs write failed: ${e.message}`);}
  broadcastWs({type:'pipelineRunSaved',run:entry});
}
const API_TIMEOUT_MS=10*60000;
// the project folder as it was when the current run started, to report what the run created or changed
const filesLib=require('./lib/files');
let runSnapshot=null;
const customRunner=new PipelineRunner({
  resolveCommand:kind=>kindOf(kind)?.cmd||CLI(kind),
  execute:args=>{
    if(args.step.kind!=='api')return executeStage(args);
    args.onActivity('Waiting for the API connection to reply');
    return executeApiStage({...args,connections,timeoutMs:API_TIMEOUT_MS});
  },
  emit:status=>{
    if(status.type==='activity')return broadcastWs({type:'pipelineActivity',id:status.id,index:status.index,activity:status.activity});
    if(runSnapshot && status.cwd && ['waiting','done','cancelled','error'].includes(status.state)){try{status.changes=filesLib.diff(runSnapshot,status.cwd);}catch{}}
    customStatus=status;broadcastWs({type:'customPipelineStatus',...status});
    if(status.state!==customRunner.lastSavedState && ['done','cancelled','error'].includes(status.state) && (status.outputs.length || status.state==='error')){saveRun(status);}
    customRunner.lastSavedState=status.state;
    if(['done','cancelled','error'].includes(status.state))usageChanged();
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

// Model + effort the user picked for each CLI (state.models), turned into that CLI's launch flags.
// Only validated values ever reach the command line.
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function paneModel(kind) {
  const m = (state.models || {})[kind] || {};
  return { model: MODEL_ID.test(m.model || '') ? m.model : '', effort: EFFORTS.includes(m.effort) ? m.effort : '' };
}
// resumeId: reopen that conversation (used when the model changes, so the pane keeps its context).
// newId: the conversation ID a fresh Claude or Grok pane starts with, so its log is known exactly.
function modelArgs(kind, resumeId, newId) {
  if (!['claude', 'codex', 'grok'].includes(kind)) return '';
  const { model, effort } = paneModel(kind);
  const args = [];
  if (model) args.push(kind === 'codex' ? '-m' : '--model', model);
  if (effort) args.push(...(kind === 'codex' ? ['-c', `model_reasoning_effort=${effort}`] : ['--effort', effort]));
  if (resumeId && SESSION_ID.test(resumeId)) {
    if (kind === 'codex') return ['resume', ...args, resumeId].join(' ');
    args.push('--resume', resumeId);
  } else if (newId && SESSION_ID.test(newId) && kind !== 'codex') args.push('--session-id', newId);
  return args.join(' ');
}
// The conversation a pane is in. Claude and Grok panes carry the ID they were launched with.
// Codex can't be given an ID, so only a log that matched a prompt this pane sent counts.
const SESSION_ID = /^[0-9a-fA-F-]{16,64}$/;
function sessionIdOf(id) {
  const s = sessions.get(id);
  if (!s) return '';
  if (s.sessionId) {
    // resuming needs a conversation that exists: a pane nobody typed into has no log yet
    const log = logPathFor(s.kind, state.cwd, s.sessionId);
    return log && fs.existsSync(log) ? s.sessionId : '';
  }
  const found = (path.basename(s.transcriptFile || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) || [])[1] || '';
  return SESSION_ID.test(found) ? found : '';
}

// Grok's interactive screen saves the --model it was launched with as the user's global default
// (~/.grok/config.toml, [models] default = "..."), and has no option to skip that. A pane's model
// pick must not change the user's own default, so VibeDeck puts it back right after Grok writes.
const GROK_CONFIG = path.join(HOME, '.grok', 'config.toml');
let grokDefault = null, grokGuardUntil = 0;
function readGrokDefault() { try { return fs.readFileSync(GROK_CONFIG, 'utf8').match(/^default = "([^"]*)"/m)?.[1] || null; } catch { return null; } }
function restoreGrokDefault() {
  if (!grokDefault) return;
  try {
    const txt = fs.readFileSync(GROK_CONFIG, 'utf8');
    const now = txt.match(/^default = "([^"]*)"/m)?.[1];
    if (now && now !== grokDefault) {
      fs.writeFileSync(GROK_CONFIG, txt.replace(/^default = "[^"]*"/m, `default = "${grokDefault}"`));
      slog(`kept Grok's default model as ${grokDefault} (a pane launched with ${now})`);
    }
  } catch {}
}
function guardGrokDefault() {
  // snapshot the user's default only when no guard is already running, so overlapping pane
  // launches can't capture a value Grok itself just wrote
  if (Date.now() > grokGuardUntil) grokDefault = readGrokDefault();
  grokGuardUntil = Date.now() + 20000;
  for (const ms of [3000, 8000, 15000]) setTimeout(restoreGrokDefault, ms);
}

// signInArgs: a provider login command ("auth login"); every other launch uses the saved model.
function spawnPane(kindId, instanceId, signInArgs, resumeId) {
  const entry = kindOf(kindId);
  const id = instanceId || `${kindId}-${++instanceSeq}`;
  if (!entry.cmd) { // PTY-less pane (notes): no process
    sessions.set(id, { kind: kindId, proc: null, alive: true, buffer: '', extraArgs: '',
                       roundOut: '', inRound: false, lastDataTs: 0, queue: [] });
    return id;
  }
  const sessionId = ['claude', 'grok'].includes(kindId) && !signInArgs
    ? (resumeId && SESSION_ID.test(resumeId) ? resumeId : require('node:crypto').randomUUID()) : '';
  const extraArgs = signInArgs || modelArgs(kindId, resumeId, sessionId);
  const picked = signInArgs ? { model: '', effort: '' } : paneModel(kindId);
  // A CLI installed under a path with spaces ("C:\Program Files\nodejs\claude.cmd") must be quoted.
  // extraArgs are only validated tokens: model IDs, effort names, session IDs, "auth login".
  const isFile = fs.existsSync(entry.cmd);
  const exe = !isFile ? entry.cmd : IS_WIN ? `"${entry.cmd}"` : `'${entry.cmd.replace(/'/g, `'\\''`)}'`;
  const cmd = exe + (extraArgs ? ' ' + extraArgs : '');
  slog(`spawn ${id}: ${cmd}`);
  if (kindId === 'grok' && picked.model) guardGrokDefault();
  let proc;
  try {
    if (IS_WIN && /["%]/.test(entry.cmd)) throw Error(`unsupported CLI path: ${entry.cmd}`);
    // windows: cmd.exe runs the .cmd shims. One pre-quoted command line (node-pty passes a string
    // through as-is); /s makes cmd strip only the outer quotes, so the quoted path survives.
    // mac/linux: login shell so the user's PATH (homebrew, nvm) is loaded before the CLI launches
    proc = pty.spawn(IS_WIN ? 'cmd.exe' : USER_SHELL, IS_WIN ? `/d /s /c "${cmd}"` : ['-lc', cmd], {
      name: 'xterm-256color',
      cols: 100,
      rows: 40,
      cwd: state.cwd,
      env: childEnv(),
    });
  } catch (e) {
    slog(`spawn FAILED ${id}: ${e.message}`);
    const dead = { kind: kindId, proc: null, buffer: `[failed to launch: ${e.message}]`, alive: false, signIn: !!signInArgs,
                   extraArgs: extraArgs || '', ...picked, roundOut: '', inRound: false, lastDataTs: 0, queue: [] };
    sessions.set(id, dead);
    setTimeout(() => broadcastWs({ type: 'exit', pane: id, code: -1 }), 100);
    return id;
  }
  const session = { kind: kindId, proc, buffer: '', alive: true, extraArgs: extraArgs || '', signIn: !!signInArgs, sessionId, ...picked, roundOut: '', inRound: false,
                    lastDataTs: Date.now(), spawnTs: Date.now(), queue: [], pendingOut: '', flushTimer: null,
                    // an invisible copy of the pane's screen: dialog checks read what is on screen now,
                    // not raw output that the CLI has since painted over
                    screen: new HeadlessTerminal({ cols: 100, rows: 40, scrollback: 0, allowProposedApi: true }) };
  sessions.set(id, session);

  // guard against stale events: after a restart/replace, the killed process's
  // onData/onExit can still fire for a pane id now owned by a fresh session
  proc.onData((data) => {
    if (sessions.get(id) !== session) return;
    session.lastDataTs = Date.now();
    session.screen?.write(data);
    session.buffer = (session.buffer + data).slice(-BUFFER_MAX);
    if (session.inRound) session.roundOut = (session.roundOut + data).slice(-ROUND_MAX);
    session.pendingOut += data;
    if (!session.flushTimer) session.flushTimer = setTimeout(() => { session.flushTimer = null; flushOut(id, session); }, FLUSH_MS);
  });
  proc.onExit(({ exitCode }) => {
    if (kindId === 'grok' && picked.model) setTimeout(restoreGrokDefault, 1500);
    session.alive = false;
    try { session.screen?.dispose(); } catch {}
    session.screen = null;
    if (sessions.get(id) !== session) return;
    flushOut(id, session); // last output must land before the exit banner
    slog(`exit ${id} code ${exitCode}`);
    broadcastWs({ type: 'exit', pane: id, code: exitCode });
  });
  return id;
}

// The text currently visible in a pane (its invisible screen copy), or the raw tail as a fallback.
function screenText(s) {
  const t = s.screen;
  if (!t) return stripAnsi(s.buffer.slice(-1500));
  const b = t.buffer.active, lines = [];
  for (let i = b.viewportY; i < b.viewportY + t.rows && i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) || '');
  return lines.join('\n');
}

// a pane is ready for a typed prompt once its input UI has painted and it has
// gone quiet — fresh CLIs (npm shims, trust dialogs, init) silently eat early text
function isReady(s) {
  if (!s.alive || s.buffer.length < 50 || Date.now() - s.lastDataTs < 1200) return false;
  const tail = stripAnsi(s.buffer.slice(-4000));
  // a pane showing any waiting screen must not get typed prompts: they would answer the question
  if (s.waiting || questionOnScreen(s)) return false;
  const pat = kindOf(s.kind).ready;
  return !pat || pat.test(tail);
}
function writePrompt(s, text) {
  s.proc.write(text);
  // multi-line text arrives as a paste; Enter too early lands mid-ingest and
  // never submits (claude shows "[Pasted text #N]" with the prompt stuck in the box)
  const delay = text.includes('\n') ? Math.min(3000, 600 + text.split('\n').length * 25) : 150;
  setTimeout(() => { if (s.alive) s.proc.write('\r'); }, delay);
  s.promptWrittenAt = Date.now() + delay; // the round watcher re-presses Enter if the CLI never logged it
}
// flush queued prompts when their pane becomes ready. The 30s failsafe covers
// panes that never go quiet (grok animates constantly) but must NOT fire while
// a startup dialog is up — the text would be eaten and Enter would answer it.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.queue.length || !s.alive) { if (!s.alive) s.queue = []; continue; }
    const dialogUp = !!s.waiting || questionOnScreen(s);
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
  { kinds: ['codex'], test: t => TRUST_DIALOG.test(t), title: 'Codex is asking to trust this folder',
    reason: 'Click into the pane, pick "Trust and continue", then press Enter. Codex asks once per folder.' },
  { kinds: ['codex'], test: t => /Update\s*available/i.test(t) && /Press\s*enter\s*to\s*continue/i.test(t), title: 'Codex has an update',
    reason: 'Pick "Update now" or "Skip" in the pane with the arrow keys, then press Enter.' },
  { kinds: ['claude', 'codex', 'grok'], test: t => /Select\s*login\s*method|Sign\s*in\s*with\s*ChatGPT|Please\s*run\s*\/login/i.test(t), title: 'Sign-in needed',
    reason: 'This CLI is not signed in. Follow the sign-in steps in the pane, or use Connections to start the provider login.' },
  // any other open choice menu: an update or new-model offer, a permission question mid-answer.
  // always: checked even while the pane is answering, since that is when permission questions appear
  { kinds: ['claude', 'codex', 'grok'], always: true, test: t => MENU_OPEN.test(t), title: 'Waiting for your answer',
    reason: 'This CLI is asking you something (for example permission to run a command, an update, or a new model). Read it in the pane and pick an answer with the arrow keys and Enter. VibeDeck never answers these for you.' },
];
setInterval(() => {
  for (const [id, s] of sessions) {
    if (!s.proc || !s.alive) { if (s.waiting) { s.waiting = null; broadcastWs({ type: 'paneWaiting', pane: id, reason: '' }); } continue; }
    // a pane that already took this round's prompt is answering, not sitting on a startup dialog;
    // skipping it keeps words like "sign in" inside an answer from gating the pane
    const answering = lastRound?.pending?.has(id) && !s.queue.length;
    const tail = screenText(s);
    const hit = WAITING.find(w => w.kinds.includes(s.kind) && (!answering || w.always) && w.test(tail));
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
  return { id, kind: s.kind, label: kindOf(s.kind).label, model: s.model || '', effort: s.effort || '', signIn: !!s.signIn,
    ran: s.ranModel || '', mismatch: !!(s.model && s.ranModel && !sameModel(s.model, s.ranModel)) };
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

// ---------- model lists (lib/models.js catalog, refreshed by "update models") ----------
const MODELS_FILE = path.join(USER_DATA, 'models.json');
const modelsLib = require('./lib/models');
let modelsCfg = modelsLib.defaultModels();
// models.json written by 2.1 and earlier held shortcut names ("opus") and stale codex IDs; only v2 files are trusted
try { const saved = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); if (saved.version === 2) { delete saved.version; modelsCfg = { ...modelsCfg, ...saved }; } } catch {}
function saveModels() {
  try { fs.writeFileSync(MODELS_FILE, JSON.stringify({ version: 2, ...modelsCfg }, null, 2)); } catch (e) { slog(`models.json write failed: ${e.message}`); }
}
// replace a kind's model list, keeping readable labels (known ones from the catalog, new ones derived)
function setModels(kind, pairs, keepMissing) {
  const cfg = modelsCfg[kind];
  const ids = pairs.map(p => p[0]);
  for (const [id, label] of pairs) cfg.labels[id] = label || cfg.labels[id] || modelsLib.labelFor(kind, id);
  cfg.models = keepMissing ? [...ids, ...cfg.models.filter(id => !ids.includes(id))] : ids;
}

// grok is the only CLI that can list its models headlessly
function grokModels() {
  return new Promise(res => {
    let child;
    try { child = spawn(kindOf('grok').cmd, ['models'], { env: childEnv(), windowsHide: true }); } catch { return res([]); }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 15000);
    child.stdout.on('data', d => out += d);
    child.on('error', () => { clearTimeout(timer); res([]); });
    child.on('close', () => {
      clearTimeout(timer);
      // "  * grok-4.5 (default)": the star marks Grok's own default model
      const def = out.match(/^\s*\*\s+(grok\S+)/m)?.[1];
      if (def) modelsCfg.grok.defaultLabel = modelsCfg.grok.labels[def] || modelsLib.labelFor('grok', def);
      res([...out.matchAll(/^\s*[*-]\s+(grok\S+)/gm)].map(m => [m[1], modelsCfg.grok.labels[m[1]] || modelsLib.labelFor('grok', m[1])]));
    });
  });
}

// claude/codex only expose their model list via the in-session /model picker:
// type it into the live pane, scrape the painted menu, Esc to close
function scrapeModelMenu(kind) {
  return new Promise(res => {
    const id = firstPaneOfKind(kind);
    const s = id && sessions.get(id);
    if (!s || !isReady(s)) return res(null); // no pane, or busy: don't type into it
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
    if (HEALTH.find(h => h.id === 'grok')?.ok) {
      const g = await grokModels();
      if (g.length) { setModels('grok', g, false); report.push(`Grok ${g.length} models`); }
      else report.push('Grok list unavailable, kept the current one');
    }
    for (const kind of ['claude', 'codex']) {
      let painted = null;
      for (let tries = 0; tries < 3 && painted === null; tries++) {
        if (tries) await new Promise(r => setTimeout(r, 4000));
        painted = await scrapeModelMenu(kind);
      }
      if (painted === null) { report.push(`${kind === 'claude' ? 'Claude' : 'Codex'} needs an idle pane to read its menu, kept the current list`); continue; }
      const pairs = modelsLib.parseMenu(kind, painted);
      // the pane chrome alone shows the CURRENT model, so demand at least 2 to trust a scrape.
      // Claude's menu scrolls, so models below the fold are kept.
      if (pairs.length >= 2) { setModels(kind, pairs, kind === 'claude'); report.push(`${kind === 'claude' ? 'Claude' : 'Codex'} ${modelsCfg[kind].models.length} models`); }
      else report.push(`${kind === 'claude' ? 'Claude' : 'Codex'} menu unclear, kept the current list`);
    }
    saveModels();
  } finally { updatingModels = false; }
  slog(`update models: ${report.join(', ')}`);
  broadcastWs({ type: 'models', config: modelsCfg, report: report.join(', ') });
}

// ---------- answers: read from each CLI's own log, terminal scraping as the fallback ----------
const { readAnswer, logPathFor, primeLogs } = require('./lib/transcripts');
// log files already matched to other live Codex panes (two panes = two sessions)
function claimedLogs(id, kind) {
  return [...sessions.entries()].filter(([oid, o]) => oid !== id && o.kind === kind && o.transcriptFile).map(([, o]) => o.transcriptFile);
}
// This pane's answer to `prompt` (or its latest answer when prompt is empty).
// Claude and Grok panes read exactly their own session log. Codex logs are found by the prompt
// this pane sent; without a prompt only a log already matched that way is trusted.
function transcriptAnswer(id, prompt, sinceTs) {
  const s = sessions.get(id);
  if (!s || !['claude', 'codex', 'grok'].includes(s.kind)) return null;
  try {
    const own = s.sessionId ? logPathFor(s.kind, state.cwd, s.sessionId) : null;
    if (!own && !prompt && !s.transcriptFile) return null;
    const found = readAnswer({ kind: s.kind, cwd: state.cwd, prompt, sinceTs: sinceTs || s.spawnTs || 0,
      file: own || (!prompt ? s.transcriptFile : null), exclude: claimedLogs(id, s.kind), prefer: s.transcriptFile });
    if (found) s.transcriptFile = found.file;
    return found;
  } catch (e) { slog(`transcript read failed for ${id}: ${e.message}`); return null; }
}
// After every answer: the model the CLI's own log says it used, checked against the model the pane
// was launched with. A CLI that switched models by itself (a new-model offer, a /model typed in the
// pane) shows up as a mismatch on the pane's chip instead of hiding. Grok logs "grok-4.6-build" for
// Grok 4.6, and Claude may add a date suffix, so "same model plus a suffix" counts as a match.
const sameModel = (want, ran) => ran === want || ran.startsWith(want + '-');
function reportRanModel(id, s, ran) {
  s.ranModel = ran;
  const mismatch = !!s.model && !sameModel(s.model, ran);
  if (mismatch) slog(`model mismatch on ${id}: launched with ${s.model}, CLI log says ${ran}`);
  broadcastWs({ type: 'paneRan', pane: id, ran, mismatch });
}

// What "-> notes", "-> sidecar" and relay send: the pane's latest answer, even if you kept
// chatting in the pane after the last broadcast.
function paneAnswer(id) {
  const s = sessions.get(id);
  const found = transcriptAnswer(id, '', 0);
  if (found?.text) return { text: found.text.slice(-12 * 1024), fromLog: true };
  return { text: extractAnswer(s.roundOut || s.buffer.slice(-24 * 1024), lastRound?.prompt).slice(-12 * 1024), fromLog: false };
}

function roundResponses() {
  if (!lastRound) return [];
  return lastRound.targets.filter(id => sessions.has(id)).map(id => {
    const s = sessions.get(id);
    const found = lastRound.answers?.[id] || transcriptAnswer(id, lastRound.prompt, lastRound.ts);
    const text = found?.text || extractAnswer(s.roundOut, lastRound.prompt);
    return { pane: id, kind: s.kind, label: kindOf(s.kind).label, text, model: found?.model || '', source: found?.text ? 'log' : 'screen', rawLen: s.roundOut.length };
  });
}

// judge: headless CLI call over the last round (prompt guard keeps it non-agentic).
// Answers go in BLIND — no model labels — so a judge can't favor its own entry;
// the label legend is prepended to the verdict after it comes back.
let judging = false;
// ts: the round shown in Compare (a saved round from History, or the live one)
function runJudge(kind, ts) {
  if (judging) return;
  if (!JUDGE_KINDS.includes(kind)) kind = JUDGE_KINDS[0];
  const saved = ts && ts !== lastRound?.ts ? readRounds().find(r => r.ts === ts) : null;
  const round = saved || (lastRound ? { ts: lastRound.ts, prompt: lastRound.prompt, responses: roundResponses() } : null);
  const responses = (round?.responses || []).filter(r => (r.text || '').length > 10)
    .map(r => ({ ...r, label: r.model ? `${r.label} (${r.model})` : r.label }));
  if (!round || responses.length < 2) {
    broadcastWs({ type: 'judgement', ok: false, kind, ts, text: 'Need a round with at least 2 answers to judge.' });
    return;
  }
  judging = true;
  const parts = responses.map((r, i) => `--- ANSWER ${i + 1} ---\n${r.text.slice(0, 5000)}`);
  const judgePrompt =
`You are judging answers from different AI coding assistants to the same prompt. You are not told which assistant wrote which answer. The transcripts may contain terminal rendering noise; judge the substance.

THE PROMPT WAS:
${(round.prompt || '').slice(0, 2000)}

${parts.join('\n\n')}

Give your verdict:
1. WINNER: which answer number and why (2-3 sentences)
2. For each answer, one line on what it missed or got wrong
3. BEST MERGED TAKE: a short synthesis of the strongest ideas

Plain text only. Do not use any tools. Do not read or write any files. Reply directly.`;

  // both judges read the prompt from stdin: claude -p, codex exec -
  const cmd = kind === 'codex' ? 'codex exec --skip-git-repo-check -' : 'claude -p';
  const child = IS_WIN
    ? spawn('cmd.exe', ['/c', cmd], { cwd: require('os').tmpdir(), env: childEnv(), windowsHide: true })
    : spawn(USER_SHELL, ['-lc', cmd], { cwd: require('os').tmpdir(), env: childEnv(), windowsHide: true });
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
    broadcastWs({ type: 'judgement', ok: !!verdict, kind, ts: round.ts,
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
  const { text: src, fromLog } = paneAnswer(fromId);
  if (fromLog ? !src.trim() : src.length < 40) {
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
    ? spawn('cmd.exe', ['/c', 'claude', '-p'], { cwd: require('os').tmpdir(), env: childEnv(), windowsHide: true })
    : spawn(USER_SHELL, ['-lc', 'claude -p'], { cwd: require('os').tmpdir(), env: childEnv(), windowsHide: true });
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
const BUSY_TAIL = /esc\s+to\s+interrupt/i;

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
    // restarted, replaced, folder switched or model changed: the session that got the prompt is gone
    const swapped = s && st.session && s !== st.session;
    if (s && s.alive && !gaveUp && !swapped) {
      if (s.queue.length) continue;
      // First choice: the CLI's own log says the turn is finished. While the log shows the
      // prompt but no finish, the CLI is still working, so screen guesses are ignored.
      if (['claude', 'codex', 'grok'].includes(s.kind) && Date.now() - (st.logCheck || 0) >= 2000) {
        st.logCheck = Date.now();
        st.log = transcriptAnswer(id, r.prompt, r.ts);
        if (st.log && st.log.mtime !== st.logMtime) { st.logMtime = st.log.mtime; st.logChangedAt = Date.now(); }
      }
      // A CLI logs a prompt the moment it is submitted. Typed but still unlogged 4s later means the
      // Enter was swallowed (Codex treats a fast burst of typing as a paste), so press it again.
      if (!st.log && ['claude', 'codex', 'grok'].includes(s.kind) && s.promptWrittenAt && Date.now() - s.promptWrittenAt > 4000
          && (st.enterRetries || 0) < 2 && !questionOnScreen(s) && screenText(s).replace(/\s+/g, ' ').includes(r.prompt.replace(/\s+/g, ' ').trim().slice(0, 24))) {
        st.enterRetries = (st.enterRetries || 0) + 1;
        s.promptWrittenAt = Date.now();
        slog(`re-pressed Enter for ${id}: its prompt was typed but not submitted`);
        s.proc.write('\r');
      }
      if (st.log) {
        // safety net for turns that end without a finish record: log unchanged for 90s and the
        // pane silent for 30s means the CLI stopped, so keep what it wrote instead of hanging
        const stalled = Date.now() - (st.logChangedAt || Date.now()) > 90000 && Date.now() - s.lastDataTs > 30000;
        if (!(st.log.done || stalled)) continue;
        if (st.log.text) (r.answers ||= {})[id] = st.log;
        if (st.log.model) reportRanModel(id, s, st.log.model);
      }
      // fallback: an all-numeric answer ("2 + 2 = 4.") cleans to nothing, so
      // settledAnswer can't see it — but output happened and the pane went
      // raw-silent, which is claude/codex's idle signature. Call it done.
      const quietDone = s.roundOut.length && Date.now() - s.lastDataTs > 15000;
      if (!st.log && settledAnswer(s, r.prompt, st) === null && !quietDone) continue;
    }
    if (!s?.alive || gaveUp || swapped) {
      r.pending.delete(id); r.failed = true;
      if (s) s.queue = []; // a prompt still waiting behind a startup screen must not be typed hours later
      broadcastWs({ type: 'answerFailed', pane: id, text: gaveUp ? 'Response timed out.' : swapped ? 'The pane restarted before it answered.' : 'Terminal exited before completing.' });
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
      responses: roundResponses().map(x => ({ pane: x.pane, kind: x.kind, label: x.label, model: x.model, text: x.text.slice(0, 16 * 1024) })) };
    appendRound(entry);
    broadcastWs({ type: 'roundSaved', round: entry });
    broadcastWs({ type: r.failed?'roundFailed':'roundDone', ts: r.ts, count: r.targets.length });
    usageChanged();
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
  const { text: src, fromLog } = paneAnswer(fromId);
  const label = kindOf(s.kind).label;
  if (fromLog ? !src.trim() : src.length < 40) {
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
    usage,
    judges: JUDGE_KINDS,
    rounds: readRounds(50),
    round: lastRound?.pending?.size ? { ts: lastRound.ts, targets: [...lastRound.pending.keys()] } : null,
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
    if(msg.type==='openPath'){
      // show a file or folder in Explorer / Finder. Only paths inside the project folder, the folder
      // the current run worked in, or a recent project folder are allowed.
      const target=path.resolve(String(msg.base||state.cwd),String(msg.rel||''));
      const inside=[state.cwd,customStatus?.cwd,...(state.recents||[])].filter(Boolean).some(root=>{const r=path.resolve(root);return (target+path.sep).toLowerCase().startsWith((r+path.sep).toLowerCase());});
      if(!inside||!fs.existsSync(target))return notice('That file is not in the project folder anymore.');
      const isFile=fs.statSync(target).isFile();
      try {
        const child=IS_WIN?spawn('explorer.exe',[isFile?`/select,${target}`:target],{detached:true,stdio:'ignore'})
          :spawn('open',isFile?['-R',target]:[target],{detached:true,stdio:'ignore'});
        child.on('error',()=>{});child.unref();
      } catch {}
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
          try { runSnapshot=filesLib.snapshot(state.cwd); } catch { runSnapshot=null; }
          customRunner.start(msg.definition,msg.prompt,state.cwd,{autoApprove:!!msg.autoApprove,handsFree:!!msg.handsFree});
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
      // quoted when the path has spaces, or the CLI reads it as two words and never attaches it
      s.proc.write((/\s/.test(file) ? `"${file}"` : file) + ' ');
      broadcastWs({ type: 'imageSaved', pane: msg.pane, file: path.basename(file) });
    } else if (msg.type === 'broadcast') {
      if(!Array.isArray(msg.targets)||typeof msg.data!=='string'||!msg.data.trim()||msg.data.length>32000)return;
      if(lastRound?.pending?.size)return notice('Wait for the current round to finish, or stop it first.');
      const targets = msg.targets.filter(id => { const t = sessions.get(id); return t?.alive && t.proc; });
      if(!targets.length)return notice('Turn on broadcast for at least one live terminal first.');
      lastRound = { ts: Date.now(), prompt: msg.data, targets,
                    pending: new Map(targets.map(id => [id, { lastCleanLen: 0, stableSince: 0, session: sessions.get(id) }])) };
      // noHist: promoted mega-prompts skip ↑/↓ history (rounds.jsonl still records them)
      if (!msg.noHist) appendHistory(lastRound.ts, msg.data);
      // note every log file's size now, so any growth during this round is seen (see lib/transcripts.js)
      for (const k of new Set(targets.map(id => sessions.get(id).kind))) { try { primeLogs(k, state.cwd); } catch {} }
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
      const { text: src } = paneAnswer(msg.pane);
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
      const ts = Number.isFinite(msg.ts) ? msg.ts : 0;
      if (judging) return notice('The judge is still reading the last round.');
      broadcastWs({ type: 'judging', kind, ts });
      runJudge(kind, ts);
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
        spawnPane(sess.kind, id, sess.signIn ? sess.extraArgs : undefined);
        reorderSessions(order);
      }
      if (!sessions.size && !process.env.VIBEDECK_NO_PANES) spawnSavedPanes();
      saveState();
      broadcastWs({ type: 'cwdChanged', cwd: state.cwd, recents: state.recents, needsFolder: needsFolder() });
      // every pane is a fresh session now: clear "ended" covers and old waiting cards
      for (const id of sessions.keys()) broadcastWs({ type: 'restarted', pane: id, info: paneInfo(id) });
    } else if (msg.type === 'resize' && s && s.alive && s.proc) {
      const cols = Math.max(2, msg.cols | 0), rows = Math.max(2, msg.rows | 0);
      try { s.proc.resize(cols, rows); } catch {}
      try { s.screen?.resize(cols, rows); } catch {}
    } else if (msg.type === 'restart' && s) {
      const order = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      // relaunches with the saved model and effort (a sign-in pane re-runs its login)
      spawnPane(s.kind, msg.pane, s.signIn ? s.extraArgs : undefined);
      reorderSessions(order);
      broadcastWs({ type: 'restarted', pane: msg.pane, info: paneInfo(msg.pane) });
    } else if (msg.type === 'paneModel' && s && ['claude', 'codex', 'grok'].includes(s.kind)) {
      // model/effort picked from a pane's chip, remembered per CLI for every future launch.
      // The pane restarts with the new launch flags and resumes the same conversation, so the
      // model is guaranteed (no typing into menus) and nothing changes the CLI's global default.
      const model = String(msg.model || ''), effort = String(msg.effort || '');
      if ((model && !MODEL_ID.test(model)) || (effort && !EFFORTS.includes(effort))) return notice('That model or effort is not valid.');
      if (lastRound?.pending?.has(msg.pane)) return notice('This pane is still answering. Change its model after the round finishes.');
      state.models = { ...(state.models || {}), [s.kind]: { model, effort } };
      saveState();
      const resumeId = sessionIdOf(msg.pane);
      const order = [...sessions.keys()];
      if (s.alive) { try { s.proc.kill(); } catch {} }
      sessions.delete(msg.pane);
      spawnPane(s.kind, msg.pane, undefined, resumeId);
      // the resumed pane is still in the same conversation, so a second switch can resume it too
      if (resumeId && sessions.get(msg.pane)) sessions.get(msg.pane).transcriptFile = s.transcriptFile;
      reorderSessions(order);
      broadcastWs({ type: 'restarted', pane: msg.pane, info: paneInfo(msg.pane), resumed: !!resumeId });
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
  // the process exits before a stopped stage finishes closing, so record the run now
  if(customRunner?.active) saveRun({...customRunner.status(), state:'cancelled', text:'VibeDeck was closed during this run.'});
  if(customRunner) customRunner.cancel();
  server.close();
  setTimeout(()=>process.exit(0),300).unref();
}
process.on('message', msg=>{if(msg?.type==='shutdown')shutdown();});
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
process.on('disconnect',shutdown);
