// lib/screen.js — ANSI/TUI text extraction for compare, relay, notes, judge.
//
// IMPORTANT: cleanTui is ALSO the settle-detection signal — settledAnswer in
// server.js keys on its output length going stable. Never change cleanTui's
// behavior for display reasons; put display-only improvements in extractAnswer.

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?<>= ]*[a-zA-Z]/g, '') // space allowed: '\x1b[0 q' cursor-style seqs
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// cursor-forward → space, cursor-positioning → newline, then strip: Ink paints
// use cursor moves instead of spaces/newlines, so plain stripAnsi fuses words
function segmentAnsi(s) {
  return stripAnsi(s.replace(/\x1b\[\d*C/g, ' ').replace(/\x1b\[[0-9;]*[HfABEFd]/g, '\n'));
}

// symbol-only lines (borders, spinners) and TUI chrome get dropped
const SYMBOL_LINE = new RegExp('^[-=>.*\\s' +
  '\\u2500\\u2502\\u256D\\u256E\\u2570\\u256F\\u2594\\u2581\\u2590\\u258C\\u259B\\u259C\\u259D\\u2598\\u2588' +
  '\\u23F5\\u00B7\\u25D0\\u25D3\\u25D1\\u25D2\\u273B\\u2736\\u273D\\u2722\\u25E6\\u203A\\u276F]+$');
const CHROME_LINE = /esc to interrupt|bypass permissions|shift\+tab|tokens\)|tokens used:|\/status|\/effort|\/model|mcp server|claude max|working \(|thinking with|↓ ?\d+ tokens|^\W*\w+…|^.{0,15}…$|\[pasted text|paste again to expand|ctrl\+g to edit|turn completed in [\d.]+s/i;

function cleanTui(s, prompt) {
  // cursor-forward becomes a space (Ink uses it instead of spaces — without this
  // words fuse: "AgreatTUIapp"), and cursor-positioning (CUP, up/down) becomes a
  // newline — claude repaints whole screens with those, so stripping alone fuses
  // every screen line into one mega-line and the filters below nuke real content
  const lines = segmentAnsi(s).split(/[\r\n]+/);
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

// Display-only extraction: cleanTui plus removal of partial-paint fragments.
// TUI repaints leave truncated prefixes of lines that a later paint completed
// ("Verdict: Conce" followed later by "Verdict: Concept approved") — cleanTui's
// exact-dupe filter can't catch those, so compare/notes/judge read mushy.
// A line is dropped when a LATER line strictly extends it (same normalized
// prefix, more content). Minimum key length guards real short lines ("Yes.")
// from being eaten by unrelated longer lines.
function extractAnswer(raw, prompt) {
  const lines = cleanTui(raw, prompt).split('\n');
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const keys = lines.map(norm);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const key = keys[i];
    if (key.length >= 6) {
      let superseded = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (keys[j].length > key.length && keys[j].startsWith(key)) { superseded = true; break; }
      }
      if (superseded) continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { stripAnsi, segmentAnsi, cleanTui, extractAnswer, SYMBOL_LINE, CHROME_LINE };
