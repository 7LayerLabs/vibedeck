'use strict';
// Reads answers straight from each CLI's own conversation log instead of scraping the terminal.
// All three CLIs draw full-screen interfaces, so the terminal only ever shows part of a long
// answer and the raw byte stream is full of repaint noise. Their logs hold the exact text.
//
//   Claude  ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl
//   Codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   (first line: session_meta with cwd)
//   Grok    ~/.grok/sessions/<encodeURIComponent(cwd)>/<session>/chat_history.jsonl
//
// readAnswer returns { text, done, model, file } or null when no log matches (callers then fall
// back to terminal scraping). "done" means the CLI itself recorded the turn as finished.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
// the logged prompt matches when either side contains the other's opening (long prompts, trailing whitespace)
function samePrompt(logged, prompt) {
  const a = norm(logged), b = norm(prompt);
  if (!a || !b) return false;
  const key = b.slice(0, 120);
  return a.includes(key) || b.includes(a.slice(0, 120));
}
const samePath = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();

// newest-first list of files modified at or after sinceTs
function recentFiles(files, sinceTs, slack = 5000) {
  const out = [];
  for (const file of files) {
    try { const st = fs.statSync(file); if (st.mtimeMs >= sinceTs - slack) out.push({ file, mtime: st.mtimeMs }); } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(x => x.file);
}
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const listDir = dir => { try { return fs.readdirSync(dir); } catch { return []; } };

// ---------- Claude ----------
function claudeUserText(e) {
  if (e.type !== 'user' || e.isMeta) return null;
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result')) return c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return null;
}
// An entry logged before the round began is an earlier ask of the same prompt, never this one.
const tooOld = (e, sinceTs) => sinceTs && e.timestamp && Date.parse(e.timestamp) < sinceTs - 3000;

function parseClaude(entries, prompt, sinceTs = 0) {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = claudeUserText(entries[i]);
    if (t !== null && prompt && tooOld(entries[i], sinceTs)) return null;
    if (t !== null && (!prompt || samePrompt(t, prompt))) { start = i; break; }
  }
  if (start < 0) return null;
  const texts = [];
  let done = false, model = '';
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    const next = claudeUserText(e);
    // Esc in the pane logs "[Request interrupted by user]": the turn is over, not still running
    if (next !== null && /^\[Request interrupted by user/.test(next.trim())) { done = true; break; }
    if (next !== null) break; // the next prompt
    if (e.type !== 'assistant') continue;
    const m = e.message || {};
    if (m.model) model = m.model;
    for (const b of m.content || []) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
    // finished: a normal end, a length cutoff, or a <synthetic> message (API error, rate or spend limit)
    done = ['end_turn', 'max_tokens', 'stop_sequence'].includes(m.stop_reason) || m.model === '<synthetic>';
  }
  return { text: texts.join('\n\n'), done, model };
}
function claudeFiles(cwd, sinceTs, home) {
  const dir = path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  return recentFiles(listDir(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)), sinceTs);
}

// ---------- Codex ----------
function parseCodex(entries, prompt, cwd, sinceTs = 0) {
  const meta = entries.find(e => e.type === 'session_meta');
  if (cwd && meta && !samePath(meta.payload?.cwd, cwd)) return null;
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const p = entries[i].payload || {};
    if (entries[i].type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = (p.content || []).map(c => c.text || '').join('\n');
      if (t.startsWith('<environment_context>')) continue;
      if (prompt && tooOld(entries[i], sinceTs)) return null;
      if (!prompt || samePrompt(t, prompt)) { start = i; break; }
    }
  }
  if (start < 0) return null;
  const texts = [];
  let done = false, final = '', model = '';
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i], p = e.payload || {};
    if (e.type === 'turn_context' && p.model) model = p.model;
    if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') break;
    if (e.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = (p.content || []).map(c => c.text || '').join('\n').trim();
      if (t) texts.push(t);
    }
    if (e.type === 'event_msg' && p.type === 'task_complete') { done = true; final = p.last_agent_message || ''; }
    // Esc in the pane or a failed request also ends the turn
    if (e.type === 'event_msg' && ['turn_aborted', 'error'].includes(p.type)) { done = true; if (p.message && !texts.length) final = String(p.message); }
  }
  if (!model) model = [...entries].reverse().find(e => e.type === 'turn_context')?.payload?.model || '';
  return { text: texts.join('\n\n') || final, done, model };
}
function codexFiles(sinceTs, home) {
  const root = path.join(home, '.codex', 'sessions');
  const files = [];
  // a log sits in the folder of the day its conversation started, so look back a week
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    for (const f of listDir(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
  return recentFiles(files, sinceTs);
}

// ---------- Grok ----------
function grokUserText(e) {
  if (e.type !== 'user' || e.synthetic_reason) return null;
  const t = (Array.isArray(e.content) ? e.content.map(c => c.text || '').join('\n') : String(e.content || ''));
  const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return m ? m[1] : null;
}
function parseGrok(entries, prompt) {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = grokUserText(entries[i]);
    if (t !== null && (!prompt || samePrompt(t, prompt))) { start = i; break; }
  }
  if (start < 0) return null;
  const texts = [];
  let done = false, model = '';
  for (let i = start + 1; i < entries.length; i++) {
    const e = entries[i];
    if (grokUserText(e) !== null) break;
    if (e.type !== 'assistant') continue;
    if (e.model_id) model = e.model_id;
    const t = typeof e.content === 'string' ? e.content : Array.isArray(e.content) ? e.content.map(c => c.text || '').join('\n') : '';
    if (t.trim()) texts.push(t.trim());
    // a closing assistant message has text and asks for no tools
    done = !!t.trim() && !(e.tool_calls && e.tool_calls.length);
  }
  return { text: texts.join('\n\n'), done, model };
}
function grokFiles(cwd, sinceTs, home) {
  const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(path.resolve(cwd)));
  return recentFiles(listDir(dir).map(s => path.join(dir, s, 'chat_history.jsonl')), sinceTs, 0);
}

// Find this pane's answer. exclude = log files already matched to other panes of the same CLI this round.
// Where a Claude or Grok session with a known ID keeps its log (VibeDeck launches panes with --session-id).
function logPathFor(kind, cwd, sessionId, home = os.homedir()) {
  if (kind === 'claude') return path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (kind === 'grok') return path.join(home, '.grok', 'sessions', encodeURIComponent(path.resolve(cwd)), sessionId, 'chat_history.jsonl');
  return null;
}

// file: read exactly this log (the pane's own session) instead of searching the folder's logs
function readAnswer({ kind, cwd, prompt, sinceTs = 0, exclude = [], prefer = null, file = null, home = os.homedir() }) {
  let files = file ? recentFiles([file], kind === 'grok' ? sinceTs : 0, 0)
    : kind === 'claude' ? claudeFiles(cwd, sinceTs, home) : kind === 'codex' ? codexFiles(sinceTs, home) : kind === 'grok' ? grokFiles(cwd, sinceTs, home) : [];
  files = files.filter(f => !exclude.includes(f));
  // the log this pane already matched comes first, even from an older date folder (a resumed session)
  if (prefer && !exclude.includes(prefer) && recentFiles([prefer], sinceTs).length) files = [prefer, ...files.filter(f => f !== prefer)];
  for (const file of files.slice(0, 12)) {
    const entries = readJsonl(file);
    const found = kind === 'claude' ? parseClaude(entries, prompt, sinceTs) : kind === 'codex' ? parseCodex(entries, prompt, cwd, sinceTs) : parseGrok(entries, prompt);
    if (found) { let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch {} return { ...found, file, mtime }; }
  }
  return null;
}

module.exports = { readAnswer, logPathFor, parseClaude, parseCodex, parseGrok, samePrompt };
