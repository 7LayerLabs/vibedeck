'use strict';
// Checkpoints and review: a snapshot of the project before every round, so whatever the agents
// change can be reviewed hunk by hunk, kept, undone, or rewound in one click.
//
// Snapshots live in a private git repository inside VibeDeck's data folder, one per project.
// It points at the project folder as its work tree but never touches the project's own .git,
// branches or history, and it works the same for folders that are not git repos at all.
//   refs/vibedeck/cp/<ts>   one commit per checkpoint, newest last
//   refs/vibedeck/review    the "reviewed so far" baseline: what the Review page diffs against.
//                           Keeping a hunk copies it into this baseline; undoing one copies the
//                           baseline back onto the file on disk.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const KEEP = 120;                    // checkpoints kept per project
const MAX_TEXT = 2 * 1024 * 1024;    // bigger files get file-level keep/undo only
// generated folders and heavy media are left out of snapshots (the project's .gitignore is honored too)
const EXCLUDE = [
  'node_modules/', '.next/', '.nuxt/', '.svelte-kit/', '.venv/', 'venv/', '__pycache__/', '.cache/', '.turbo/',
  '.vercel/', '.parcel-cache/', 'coverage/', 'dist/', 'build/', 'out/', 'target/', '.gradle/', '.idea/',
  '*.mp4', '*.mov', '*.avi', '*.mkv', '*.webm', '*.mp3', '*.wav', '*.flac', '*.zip', '*.7z', '*.rar', '*.tar', '*.gz',
  '*.iso', '*.exe', '*.dll', '*.msi', '*.dmg', '*.pdb', '*.psd', '*.node', '*.sqlite', '*.db', '*.log',
];

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const isText = buf => !buf.subarray(0, 8000).includes(0) && buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'));
const bad = (msg, status = 400) => Object.assign(Error(msg), { status });

function createCheckpoints({ dataDir, log = () => {} }) {
  const reposDir = path.join(dataDir, 'checkpoints');
  const queues = new Map();   // one git operation at a time per project
  const ready = new Set();

  const keyOf = root => path.resolve(root).toLowerCase();
  const gitDirOf = root => path.join(reposDir, crypto.createHash('sha1').update(keyOf(root)).digest('hex').slice(0, 16) + '.git');

  function git(root, args, { input, index, buffer, bare, timeout = 60000 } = {}) {
    const gitDir = gitDirOf(root);
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    if (!bare) Object.assign(env, { GIT_DIR: gitDir, GIT_WORK_TREE: path.resolve(root), GIT_INDEX_FILE: path.join(gitDir, index || 'index') });
    Object.assign(env, {
      GIT_AUTHOR_NAME: 'VibeDeck', GIT_AUTHOR_EMAIL: 'checkpoints@vibedeck.local',
      GIT_COMMITTER_NAME: 'VibeDeck', GIT_COMMITTER_EMAIL: 'checkpoints@vibedeck.local',
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    });
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true', ...args],
        { env, cwd: path.resolve(root), timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: buffer ? 'buffer' : 'utf8' },
        (err, out, errOut) => err ? reject(Object.assign(Error(String(errOut || err.message).trim().split('\n').pop() || 'git failed'), { git: true })) : resolve(out));
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }

  // run fn after every earlier operation on this project, so snapshots never interleave
  function serial(root, fn) {
    const k = keyOf(root);
    const prev = queues.get(k) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(k, next.catch(() => {}));
    return next;
  }

  async function init(root) {
    const k = keyOf(root);
    if (ready.has(k)) return;
    const gitDir = gitDirOf(root);
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(reposDir, { recursive: true });
      await git(root, ['init', '--quiet', '--bare', gitDir], { bare: true });
      await git(root, ['config', 'core.bare', 'false']);
      await git(root, ['config', 'gc.auto', '0']);
      fs.writeFileSync(path.join(gitDir, 'vibedeck-root.txt'), path.resolve(root));
    }
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
    // store raw bytes: no line-ending conversion, no LFS or other filters from the project's .gitattributes
    fs.writeFileSync(path.join(gitDir, 'info', 'attributes'), '* -text -eol -filter -ident -working-tree-encoding\n');
    ready.add(k);
  }

  // the project as it is on disk right now, as a tree id
  async function currentTree(root) {
    // a file that is locked or vanishes mid-scan is skipped (git still exits non-zero); the rest is saved
    await git(root, ['add', '--all', '--ignore-errors', '--', '.']).catch(e => log(`checkpoint add: ${e.message}`));
    return (await git(root, ['write-tree'])).trim();
  }

  async function refs(root) {
    const out = await git(root, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(tree)%00%(subject)', 'refs/vibedeck/cp/']);
    return out.split('\n').filter(Boolean).map(line => {
      const [ref, id, tree, subject] = line.split('\0');
      let meta = {};
      try { meta = JSON.parse(subject); } catch {}
      return { ref, id, tree, ts: Number(ref.split('/').pop()) || 0, label: meta.label || 'Checkpoint', prompt: meta.prompt || '', kind: meta.kind || 'manual' };
    });
  }

  async function readReview(root) {
    try {
      const out = (await git(root, ['for-each-ref', '--format=%(objectname)%00%(tree)%00%(subject)', 'refs/vibedeck/review'])).trim();
      if (!out) return null;
      const [id, tree, subject] = out.split('\0');
      let meta = {};
      try { meta = JSON.parse(subject); } catch {}
      return { id, tree, from: meta.from || '', fromTs: meta.fromTs || 0 };
    } catch { return null; }
  }
  async function writeReview(root, tree, from, fromTs) {
    const id = (await git(root, ['commit-tree', tree, '-m', JSON.stringify({ from, fromTs })])).trim();
    await git(root, ['update-ref', 'refs/vibedeck/review', id]);
    return { id, tree, from, fromTs };
  }

  // ---------- public: snapshots ----------
  // kind: round | relay | pipeline | typed | manual | safety. Identical trees are not saved twice.
  function snapshot(root, { kind = 'manual', label = 'Checkpoint', prompt = '' } = {}) {
    return serial(root, async () => {
      await init(root);
      const tree = await currentTree(root);
      const all = await refs(root);
      const last = all[all.length - 1];
      let cp, created = false;
      if (last && last.tree === tree && kind !== 'manual') cp = last;
      else {
        let ts = Date.now();
        if (last && ts <= last.ts) ts = last.ts + 1;
        const msg = JSON.stringify({ kind, label, prompt: String(prompt).replace(/\s+/g, ' ').trim().slice(0, 400) });
        const id = (await git(root, ['commit-tree', tree, ...(last ? ['-p', last.id] : []), '-m', msg])).trim();
        await git(root, ['update-ref', `refs/vibedeck/cp/${ts}`, id]);
        cp = { id, tree, ts, kind, label, prompt };
        created = true;
        // prune the oldest, and compact the object store now and then
        if (all.length + 1 > KEEP) for (const old of all.slice(0, all.length + 1 - KEEP)) await git(root, ['update-ref', '-d', old.ref]).catch(() => {});
        if (all.length % 25 === 24) git(root, ['gc', '--quiet', '--prune=now'], { timeout: 300000 }).catch(e => log(`checkpoint gc: ${e.message}`));
      }
      // nothing waiting for review: the review starts over from this checkpoint
      const review = await readReview(root);
      if (kind !== 'safety' && (!review || review.tree === tree)) await writeReview(root, tree, cp.id, cp.ts);
      return { ...cp, created };
    });
  }

  function list(root) {
    return serial(root, async () => {
      await init(root);
      const all = (await refs(root)).reverse().map(({ ref, ...c }) => c);
      return { checkpoints: all, review: await readReview(root) };
    });
  }

  // ---------- public: what changed since the review baseline ----------
  function changes(root) {
    return serial(root, async () => {
      await init(root);
      const review = await readReview(root);
      if (!review) return { review: null, files: [] };
      const cur = await currentTree(root);
      if (cur === review.tree) return { review, files: [], tree: cur };
      const [num, entries] = await Promise.all([
        git(root, ['diff-tree', '-r', '--no-renames', '--numstat', '-z', review.tree, cur]),
        diffTrees(root, review.tree, cur),
      ]);
      const stats = new Map();
      for (const rec of num.split('\0').filter(Boolean)) {
        const [a, d, ...p] = rec.split('\t');
        stats.set(p.join('\t'), { add: a === '-' ? null : Number(a), del: d === '-' ? null : Number(d) });
      }
      const files = entries.map(({ rel, status }) => {
        const s = stats.get(rel) || {};
        return { rel, status, add: s.add ?? null, del: s.del ?? null, binary: s.add == null };
      });
      files.sort((a, b) => a.rel.localeCompare(b.rel));
      return { review, files, tree: cur };
    });
  }

  // [{rel, status}] between two trees. Nested git repos (gitlinks) are not files we can restore, so they are skipped.
  async function diffTrees(root, a, b) {
    const parts = (await git(root, ['diff-tree', '-r', '--no-renames', '--raw', '-z', a, b])).split('\0');
    const out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const m = /^:(\d+) (\d+) \S+ \S+ ([A-Z])/.exec(parts[i]);
      if (!m || !parts[i + 1]) continue;
      if (m[1] === '160000' || m[2] === '160000') continue;
      out.push({ rel: parts[i + 1], status: m[3] === 'A' ? 'A' : m[3] === 'D' ? 'D' : 'M' });
    }
    return out;
  }

  async function blobAt(root, tree, rel) {
    const out = await git(root, ['ls-tree', '-z', tree, '--', rel]);
    const m = /^\d+ blob ([0-9a-f]{40})\t/.exec(out);
    return m ? git(root, ['cat-file', 'blob', m[1]], { buffer: true }) : null;
  }
  const diskPath = (root, rel) => {
    const clean = String(rel || '').replace(/\\/g, '/');
    if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.split('/').some(s => s === '..' || s.toLowerCase() === '.git')) throw bad('That path is not inside the project.');
    const full = path.resolve(root, clean);
    if (!(full.toLowerCase() + path.sep).startsWith(path.resolve(root).toLowerCase() + path.sep)) throw bad('That path is not inside the project.');
    return full;
  };
  const readDisk = full => { try { return fs.readFileSync(full); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function describe(buf) {
    if (!buf) return { exists: false };
    if (buf.length > MAX_TEXT) return { exists: true, kind: 'large', size: buf.length };
    if (!isText(buf)) return { exists: true, kind: 'binary', size: buf.length };
    return { exists: true, kind: 'text', size: buf.length, text: buf.toString('utf8') };
  }

  // one file: the baseline and what is on disk now
  function file(root, rel) {
    return serial(root, async () => {
      await init(root);
      const full = diskPath(root, rel);
      const review = await readReview(root);
      const before = review ? await blobAt(root, review.tree, rel) : null;
      const after = readDisk(full);
      return { rel, before: describe(before), after: describe(after), hash: after ? sha1(after) : null };
    });
  }

  // ---------- public: keep ----------
  // text given: the baseline for this file becomes that text (one kept hunk applied by the client).
  // whole: the baseline takes the file exactly as it is on disk now (or drops it if it is gone).
  function keep(root, { rel, text, whole }) {
    return serial(root, async () => {
      await init(root);
      const full = diskPath(root, rel);
      const review = await readReview(root);
      if (!review) throw bad('Nothing to review yet.');
      const content = whole ? readDisk(full) : Buffer.from(String(text ?? ''), 'utf8');
      const idx = 'review-index';
      await git(root, ['read-tree', review.tree], { index: idx });
      if (content) {
        const blob = (await git(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: content })).trim();
        await git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel.replace(/\\/g, '/')}`], { index: idx });
      } else await git(root, ['update-index', '--force-remove', '--', rel], { index: idx });
      const tree = (await git(root, ['write-tree'], { index: idx })).trim();
      return writeReview(root, tree, review.from, review.fromTs);
    });
  }
  function keepAll(root) {
    return serial(root, async () => {
      await init(root);
      const review = await readReview(root);
      return writeReview(root, await currentTree(root), review?.from || '', review?.fromTs || 0);
    });
  }

  // ---------- public: undo ----------
  // text given: write it to the file (one undone hunk applied by the client), only if the file is
  // still what the client saw (expect = its sha1). whole: put the baseline version back.
  async function undo(root, { rel, text, whole, expect }) {
    await snapshot(root, { kind: 'safety', label: 'Before undo' });
    return serial(root, async () => {
      const full = diskPath(root, rel);
      const now = readDisk(full);
      if (expect !== undefined && (now ? sha1(now) : null) !== expect) throw bad('That file changed on disk while you were looking at it. It has been reloaded.', 409);
      let content;
      if (whole) {
        const review = await readReview(root);
        if (!review) throw bad('Nothing to review yet.');
        content = await blobAt(root, review.tree, rel);
      } else content = Buffer.from(String(text ?? ''), 'utf8');
      writeOrDelete(root, full, content);
      return { ok: true };
    });
  }

  function writeOrDelete(root, full, content) {
    if (content) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); return; }
    try { fs.rmSync(full, { force: true }); } catch {}
    // clear out folders the agent created that are now empty
    const top = path.resolve(root).toLowerCase();
    for (let dir = path.dirname(full); dir.toLowerCase() !== top && dir.toLowerCase().startsWith(top); dir = path.dirname(dir)) {
      try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
    }
  }

  // make the project match a tree: changed and deleted files come back, added files go away
  async function restoreTree(root, target) {
    const cur = await currentTree(root);
    if (cur === target) return 0;
    let n = 0;
    for (const { rel, status } of await diffTrees(root, target, cur)) {
      writeOrDelete(root, diskPath(root, rel), status === 'A' ? null : await blobAt(root, target, rel));
      n++;
    }
    return n;
  }

  // every file back to how it was at a checkpoint. A safety checkpoint first, so this can be undone too.
  async function rewind(root, id) {
    await snapshot(root, { kind: 'safety', label: 'Before rewind' });
    return serial(root, async () => {
      const cp = (await refs(root)).find(c => c.id === id);
      if (!cp) throw bad('That checkpoint no longer exists.', 404);
      const n = await restoreTree(root, cp.tree);
      await writeReview(root, cp.tree, cp.id, cp.ts);
      return { files: n, to: { id: cp.id, ts: cp.ts, label: cp.label } };
    });
  }
  async function undoAll(root) {
    await snapshot(root, { kind: 'safety', label: 'Before undo all' });
    return serial(root, async () => {
      const review = await readReview(root);
      if (!review) throw bad('Nothing to review yet.');
      return { files: await restoreTree(root, review.tree) };
    });
  }

  // review everything changed since a given checkpoint (starts the baseline over)
  function reviewFrom(root, id) {
    return serial(root, async () => {
      await init(root);
      const cp = (await refs(root)).find(c => c.id === id);
      if (!cp) throw bad('That checkpoint no longer exists.', 404);
      return writeReview(root, cp.tree, cp.id, cp.ts);
    });
  }

  return { snapshot, list, changes, file, keep, keepAll, undo, undoAll, rewind, reviewFrom, gitDirOf, EMPTY_TREE };
}

module.exports = { createCheckpoints };
