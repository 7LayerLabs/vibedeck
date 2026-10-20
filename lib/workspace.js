'use strict';
// Project explorer: lists, reads and watches files in the folders VibeDeck knows about (the
// active project folder and the recent ones). Every path is checked to stay inside one of them,
// symlinks included, so the explorer can never be pointed at the rest of the disk.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// shown in the tree but dimmed, never walked for quick open or watched
const HEAVY = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', '.vercel', '.parcel-cache']);
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const MAX_ENTRIES = 3000;
const MAX_READ = 2 * 1024 * 1024;
const MAX_ALL = 12000;
const IMAGES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };

const key = p => path.resolve(p).toLowerCase();
const inside = (target, base) => (key(target) + path.sep).startsWith(key(base) + path.sep);
const posix = rel => rel.split(path.sep).join('/');

function createWorkspace({ roots, onChange, log = () => {} }) {
  // root must be one of the allowed folders, exactly
  function baseOf(root) {
    const want = key(String(root || ''));
    const hit = roots().find(r => r && key(r) === want);
    if (!hit) throw Object.assign(Error('That folder is not one of your workspaces.'), { status: 403 });
    return path.resolve(hit);
  }
  function resolveIn(root, rel) {
    const base = baseOf(root);
    const target = path.resolve(base, String(rel || '').replace(/^[\\/]+/, ''));
    if (!inside(target, base)) throw Object.assign(Error('That path is outside the workspace.'), { status: 403 });
    let real = target, realBase = base;
    try { real = fs.realpathSync(target); realBase = fs.realpathSync(base); } catch {}
    if (!inside(real, realBase)) throw Object.assign(Error('That path is outside the workspace.'), { status: 403 });
    return { base, target };
  }

  function list(root, rel) {
    const { target } = resolveIn(root, rel);
    const entries = [];
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
      if (HIDDEN.has(e.name)) continue;
      let dir = e.isDirectory();
      if (e.isSymbolicLink()) { try { dir = fs.statSync(path.join(target, e.name)).isDirectory(); } catch { continue; } }
      else if (!dir && !e.isFile()) continue;
      entries.push({ name: e.name, dir, heavy: dir && HEAVY.has(e.name) });
      if (entries.length >= MAX_ENTRIES) break;
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => (b.dir - a.dir) || coll.compare(a.name, b.name));
    return { entries, truncated: entries.length >= MAX_ENTRIES };
  }

  function read(root, rel) {
    const { target } = resolveIn(root, rel);
    const st = fs.statSync(target);
    if (st.isDirectory()) throw Object.assign(Error('That is a folder.'), { status: 400 });
    const ext = path.extname(target).slice(1).toLowerCase();
    const base = { size: st.size, mtime: Math.round(st.mtimeMs) };
    if (IMAGES[ext]) return { ...base, kind: 'image' };
    if (st.size > MAX_READ) return { ...base, kind: 'large' };
    const buf = fs.readFileSync(target);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
    return { ...base, kind: 'text', text: buf.toString('utf8') };
  }

  function raw(root, rel) {
    const { target } = resolveIn(root, rel);
    const type = IMAGES[path.extname(target).slice(1).toLowerCase()];
    if (!type) throw Object.assign(Error('Only images can be previewed.'), { status: 400 });
    return { file: target, type };
  }

  // every file under the folder, for Go to file. Heavy folders are skipped.
  function all(root) {
    const base = baseOf(root);
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 14 || out.length >= MAX_ALL) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= MAX_ALL) return;
        if (HIDDEN.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!HEAVY.has(e.name)) walk(full, depth + 1); }
        else if (e.isFile()) out.push(posix(path.relative(base, full)));
      }
    };
    walk(base, 0);
    return { files: out, truncated: out.length >= MAX_ALL };
  }

  // git branch + per-file status, paths relative to the workspace folder (it may sit inside a bigger repo)
  // A folder's own .git/config can name commands that "git status" runs (core.fsmonitor, clean/process
  // filters), so opening a downloaded folder could run code. fsmonitor is forced off, and status is
  // skipped for repos whose local config sets a filter command.
  function git(root) {
    const base = baseOf(root);
    const run = args => new Promise(resolve => execFile('git', ['-c', 'core.fsmonitor=false', '-C', base, ...args], { timeout: 6000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : String(out))));
    return run(['rev-parse', '--show-prefix']).then(prefix => {
      if (prefix === null) return { repo: false, files: {} };
      prefix = prefix.trim();
      return run(['config', '--local', '--get-regexp', '^filter\\..*\\.(clean|process)$']).then(filters => filters ? null : run(['status', '--porcelain=v1', '-b', '-z'])).then(out => {
        const res = { repo: true, branch: '', ahead: 0, behind: 0, files: {} };
        if (out === null) return res;
        const parts = out.split('\0');
        for (let i = 0; i < parts.length; i++) {
          const line = parts[i];
          if (!line) continue;
          if (line.startsWith('## ')) {
            const head = line.slice(3);
            res.branch = head.split('...')[0].replace(/^No commits yet on /, '').trim();
            res.ahead = Number(/ahead (\d+)/.exec(head)?.[1] || 0);
            res.behind = Number(/behind (\d+)/.exec(head)?.[1] || 0);
            continue;
          }
          const xy = line.slice(0, 2);
          let file = line.slice(3);
          if (xy[0] === 'R' || xy[0] === 'C') i++; // the old name follows a rename
          if (prefix) { if (!file.startsWith(prefix)) continue; file = file.slice(prefix.length); }
          const code = xy === '??' ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : xy.includes('U') ? 'C' : 'M';
          res.files[file.replace(/\/$/, '')] = code;
        }
        return res;
      });
    });
  }

  // live updates for the active folder: batched, and .git churn only signals a git refresh
  let watcher = null, watchedBase = '', pending = new Set(), gitPending = false, timer = null;
  function flush() {
    timer = null;
    const rels = [...pending];
    pending = new Set();
    const gitOnly = !rels.length && gitPending;
    gitPending = false;
    onChange({ root: watchedBase, rels: rels.length > 400 ? null : rels, gitOnly });
  }
  function watch(root) {
    unwatch();
    let base;
    try { base = baseOf(root); } catch { return; }
    try {
      watcher = fs.watch(base, { recursive: true }, (_evt, name) => {
        if (!name) return;
        const rel = posix(String(name));
        const top = rel.split('/');
        if (top[0] === '.git') { if (/^\.git\/(index|HEAD|refs\/)/.test(rel)) { gitPending = true; if (!timer) timer = setTimeout(flush, 400); } return; }
        if (top.some(seg => HEAVY.has(seg))) return;
        pending.add(rel);
        if (!timer) timer = setTimeout(flush, 250);
      });
      watcher.on('error', e => { log(`explorer watch error: ${e.message}`); unwatch(); });
      watchedBase = base;
    } catch (e) { log(`explorer watch failed: ${e.message}`); watcher = null; }
  }
  function unwatch() {
    try { watcher?.close(); } catch {}
    watcher = null; watchedBase = ''; pending = new Set(); gitPending = false;
    clearTimeout(timer); timer = null;
  }

  return { list, read, raw, all, git, watch, unwatch, resolveIn };
}

module.exports = { createWorkspace };
