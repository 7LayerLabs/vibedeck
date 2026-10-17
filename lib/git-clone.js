'use strict';
// Clone from Git: checks a repo link and where it should go, then runs `git clone` with live
// progress. It never writes into a folder that already has files, and a failed or cancelled
// clone removes only what it made.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { childEnv } = require('./env');

// https and ssh only: git's other transports (file://, ext::, plain paths) read the local disk
// or run commands. A copied browser link (github.com/owner/repo/tree/main) is trimmed to the repo.
function normalizeUrl(input) {
  let url = String(input || '').trim().replace(/^"|"$/g, '');
  if (/^(www\.)?github\.com\//i.test(url)) url = 'https://' + url.replace(/^www\./i, '');
  const gh = /^https:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url);
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}.git`;
  if (/^https:\/\/[\w.-]+(:\d+)?\/\S+$/i.test(url)) return url;
  if (/^ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/\S+$/i.test(url)) return url;
  if (/^\w[\w.-]*@[\w.-]+:[\w~][^\s]*$/.test(url)) return url; // git@github.com:owner/repo.git
  throw Error('Paste an https or ssh repo link, like https://github.com/owner/repo');
}

// the folder git would make: the link's last part without ".git"
function repoName(url) {
  return String(url || '').replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/i, '');
}

// a single folder name Windows, macOS and Linux all accept
function checkName(name) {
  name = String(name || '').trim();
  if (!name || /^\.+$/.test(name) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) throw Error(`That is not a usable folder name: ${name || '(empty)'}`);
  return name;
}

// parent must be a real folder; the target inside it must be missing or empty
function destination(parent, name) {
  parent = String(parent || '').trim().replace(/^"|"$/g, '');
  if (!parent) throw Error('Choose where to put it.');
  if (!path.isAbsolute(parent)) throw Error('Use a full folder path for where to put it, like C:\\Users\\you\\code');
  try { if (!fs.statSync(parent).isDirectory()) throw 0; }
  catch { throw Error(`That folder does not exist: ${parent}. Use Browse to pick one or make a new one.`); }
  const target = path.join(path.resolve(parent), checkName(name));
  let existed = false;
  try {
    if (!fs.statSync(target).isDirectory()) throw Error(`A file named ${path.basename(target)} is already there.`);
    if (fs.readdirSync(target).length) throw Error(`${target} already has files in it. Pick another folder name.`);
    existed = true;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { target, existed };
}

// git prints progress as \r-separated updates on stderr; the newest line is the one to show
const lastLine = text => text.split(/[\r\n]+/).map(l => l.replace(/^remote:\s*/, '').trim()).filter(Boolean).pop() || '';

function clone({ url, target, existed, onProgress = () => {}, onDone = () => {}, log = () => {} }) {
  let tail = '', sent = 0, cancelled = false, finished = false;
  // GIT_TERMINAL_PROMPT=0: with no terminal attached, a password prompt would wait forever.
  // Git Credential Manager still signs in through its own window.
  const child = spawn('git', ['clone', '--progress', '--', url, target], { windowsHide: true, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }) });
  log(`clone start: ${url} -> ${target}`);
  // remove what this clone made: the whole folder, or only its contents when it was already there (empty)
  function cleanup() {
    const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
    try {
      if (!existed) fs.rmSync(target, opts);
      else for (const entry of fs.readdirSync(target)) fs.rmSync(path.join(target, entry), opts);
    } catch (e) { log(`clone cleanup failed: ${e.message}`); }
  }
  function finish(result) {
    if (finished) return;
    finished = true;
    if (!result.ok) cleanup();
    log(`clone ${result.ok ? 'done' : cancelled ? 'cancelled' : 'failed'}: ${target}${result.error ? ` (${result.error})` : ''}`);
    onDone(result);
  }
  child.stderr.on('data', chunk => {
    tail = (tail + chunk).slice(-4000);
    const now = Date.now();
    if (now - sent > 150) { sent = now; onProgress(lastLine(tail)); }
  });
  child.stdout.on('data', () => {});
  child.on('error', e => finish({ ok: false, error: e.code === 'ENOENT' ? 'Git is not installed. Get it from https://git-scm.com and try again.' : e.message }));
  child.on('close', code => {
    if (cancelled) return finish({ ok: false, cancelled: true });
    if (code === 0) return finish({ ok: true });
    const lines = tail.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    const why = lines.filter(l => /^(fatal|error):/i.test(l)).pop() || lines.pop() || `git exited with code ${code}`;
    finish({ ok: false, error: why.replace(/^(fatal|error):\s*/i, '') });
  });
  return {
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      // git hands the download to helper processes, so stop the whole tree
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    },
  };
}

module.exports = { normalizeUrl, repoName, checkName, destination, clone };
