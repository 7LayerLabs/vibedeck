'use strict';
// What a pipeline run changed in the project folder: a quick size + modified-time snapshot before
// the run, compared afterwards. Big generated folders are skipped so large projects stay fast.
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache', 'coverage']);
const MAX_FILES = 5000;

function snapshot(root) {
  const files = new Map();
  const walk = (dir, depth) => {
    if (depth > 8 || files.size >= MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.size >= MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(full); files.set(path.relative(root, full), `${st.size}:${Math.round(st.mtimeMs)}`); } catch {}
    }
  };
  walk(root, 0);
  return files;
}

// { created: [...], changed: [...], deleted: [...] } as paths relative to the folder
function diff(before, root) {
  const after = snapshot(root);
  const created = [], changed = [], deleted = [];
  for (const [rel, sig] of after) {
    if (!before.has(rel)) created.push(rel);
    else if (before.get(rel) !== sig) changed.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) deleted.push(rel);
  const sort = a => a.sort((x, y) => x.localeCompare(y)).slice(0, 200);
  return { created: sort(created), changed: sort(changed), deleted: sort(deleted) };
}

module.exports = { snapshot, diff };
