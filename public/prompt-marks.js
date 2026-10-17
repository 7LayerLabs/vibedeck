// Your prompts, highlighted inside the terminal panes so you can scroll back to each question and
// read down from it. Prompts come from the prompt box (broadcast), from text typed straight into a
// pane, and from prompt history. Each pane's buffer is scanned for lines that spell out a known
// prompt, ignoring the CLI's own pointer and box characters ("❯", "›", "│"), so it works the same
// for every CLI. Matching lines get a colored band and a mark on the pane's scrollbar.
// Ctrl+Shift+Up / Ctrl+Shift+Down jump to the previous / next prompt in the focused pane.
(function () {
  const MAX_KNOWN = 200;
  const known = [];            // whitespace-free prompt keys, newest last
  let byFirst = new Map();     // first character -> keys starting with it
  const panes = new Set();

  const keyOf = s => String(s || '').replace(/\s+/g, '');
  const LEAD = /^[\s│┃║|▌▎▍>›❯»]+/, TRAIL = /[\s│┃║|█▐▕▏░▒▓╎╏┆┇┊┋]+$/;
  // Grok prints the time at the right end of each message's first line ("   12:31 PM"), and may
  // draw a scrollbar in the last column
  const CLOCK = /\s{2,}\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AaPp][Mm])?\s*$/;
  const lineKey = line => line ? keyOf(line.translateToString(true).replace(TRAIL, '').replace(CLOCK, '').replace(LEAD, '')) : '';

  function reindex() {
    byFirst = new Map();
    for (const k of known) { const a = byFirst.get(k[0]) || []; a.push(k); byFirst.set(k[0], a); }
  }
  // typed prompts aren't in the server's prompt history, so the list is kept here across reloads
  const STORE = 'vibedeck-prompt-keys';
  let saveTimer = 0;
  try { (JSON.parse(localStorage.getItem(STORE)) || []).slice(-MAX_KNOWN).forEach(k => typeof k === 'string' && known.push(k)); } catch {}
  reindex();
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(known)); } catch {} }, 500);
  }
  function remember(text, quiet) {
    const k = keyOf(text);
    if (k.length < 3) return;
    const i = known.indexOf(k);
    if (i >= 0) known.splice(i, 1);
    known.push(k);
    if (known.length > MAX_KNOWN) known.shift();
    reindex();
    save();
    if (!quiet) panes.forEach(p => schedule(p));
  }

  // ---------- look: settings come from VDSettings (settings.js) ----------
  function look() {
    const s = (window.VDSettings && VDSettings.get('promptHighlight')) || {};
    if (s.on === false) return null;
    const color = /^#[0-9a-f]{6}$/i.test(s.color || '') ? s.color : '#2dd4bf';
    return { color, tint: mix(color, '#0b0c0f', s.strength === 'strong' ? 0.34 : 0.2) };
  }
  function mix(a, b, t) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
  }

  // ---------- scanning ----------
  function schedule(p, full) {
    const st = p.marks;
    if (full) st.full = true;
    if (st.timer) return;
    st.timer = setTimeout(() => { st.timer = 0; const f = st.full; st.full = false; scan(p, f); }, 140);
  }

  // a decoration does not dispose its marker, and a live marker is updated on every buffer change
  const drop = d => { d.deco.dispose(); d.marker.dispose(); };
  function clear(p) {
    p.marks.decos.forEach(drop);
    p.marks.decos = [];
  }

  function scan(p, full) {
    const t = p.term, st = p.marks;
    if (!t || p.dead) return;
    const b = t.buffer.active, total = b.length;
    const L = look();
    if (!L) { clear(p); st.scanned = total; return; }
    if (total < st.scanned) full = true; // scrollback was cleared
    if (full || L.color !== st.color || L.tint !== st.tint || t.cols !== st.cols) { clear(p); full = true; }
    Object.assign(st, { color: L.color, tint: L.tint, cols: t.cols });

    // rescan from a little above whatever might have changed: new lines and the live screen area
    const from = full ? 0 : Math.max(0, Math.min(st.scanned, b.baseY) - 60);
    st.scanned = total;
    const keys = [];
    for (let i = from; i < total; i++) keys.push(lineKey(b.getLine(i)));

    // lines that spell out a whole known prompt (or at least its first 40 characters, for long
    // prompts a CLI shortens); a prompt that wraps over several lines matches as one run
    const want = new Map(); // absolute line -> first line of its prompt
    for (let i = 0; i < keys.length;) {
      const k = keys[i];
      let best = 0;
      if (k.length >= 2) for (const P of byFirst.get(k[0]) || []) {
        if (!P.startsWith(k) || k.length < Math.min(P.length, 6)) continue;
        let off = k.length, j = i + 1, blanks = 0;
        while (off < P.length && j < keys.length) {
          const kj = keys[j];
          if (!kj) { if (++blanks > 2) break; j++; continue; }
          if (!P.startsWith(kj, off)) break;
          off += kj.length; j++; blanks = 0;
        }
        while (j > i + 1 && !keys[j - 1]) j--;
        if ((off === P.length || off >= 40) && j - i > best) best = j - i;
      }
      if (best) { for (let n = 0; n < best; n++) if (keys[i + n]) want.set(from + i + n, n === 0); i += best; }
      else i++;
    }

    // keep decorations that still match, drop ones whose line changed, add the missing ones
    const have = new Map();
    st.decos = st.decos.filter(d => {
      if (d.marker.isDisposed) { d.deco.dispose(); return false; }
      const ln = d.marker.line;
      if (ln >= from && (!want.has(ln) || want.get(ln) !== d.first || have.has(ln))) { drop(d); return false; }
      have.set(ln, d);
      return true;
    });
    const cursorAbs = b.baseY + b.cursorY;
    for (const [ln, first] of want) {
      if (have.has(ln)) continue;
      const marker = t.registerMarker(ln - cursorAbs);
      if (!marker) continue;
      const deco = t.registerDecoration({
        marker, width: t.cols, layer: 'bottom', backgroundColor: L.tint,
        overviewRulerOptions: first ? { color: L.color, position: 'full' } : undefined,
      });
      if (!deco) { marker.dispose(); continue; }
      // xterm calls this on every frame the element exists; style it once
      deco.onRender(el => {
        if (el.dataset.vd) return;
        el.dataset.vd = '1';
        el.style.pointerEvents = 'none';
        el.style.boxShadow = `inset 3px 0 0 ${L.color}`;
      });
      st.decos.push({ marker, deco, first });
    }
  }

  // ---------- jumping between prompts ----------
  function jump(p, dir) {
    const b = p.term.buffer.active, top = b.viewportY;
    const firsts = p.marks.decos.filter(d => d.first && !d.marker.isDisposed).map(d => d.marker.line).sort((a, c) => a - c);
    const target = dir < 0 ? firsts.filter(l => l < top).pop() : firsts.find(l => l > top + 1);
    if (target == null) {
      if (dir > 0) p.term.scrollToBottom();
      return;
    }
    p.term.scrollToLine(Math.max(0, target - 1));
  }

  // ---------- typed straight into a pane ----------
  // The CLIs turn on bracketed paste, so a paste arrives wrapped and its newlines are not Enter.
  function typed(p, d) {
    const st = p.marks;
    if (!st) return;
    if (d === '\x1b[I' || d === '\x1b[O') return; // focus reports
    if (d.includes('\x1b[200~')) { st.buf += d.replace(/\x1b\[20[01]~/g, '').replace(/\r\n?/g, '\n'); return; }
    if (d === '\x1b\r' || d === '\x1b\n') { st.buf += '\n'; return; } // Alt/Shift+Enter: new line
    if (d[0] === '\x1b') { st.dirty = true; return; } // arrows and other keys: edits we can't follow
    for (const c of d) {
      if (c === '\r') {
        if (st.buf.trim()) { remember(st.buf); if (!/^\s*\//.test(st.buf)) window.PromptMarks.onAsk?.(p, st.buf); } // not /commands
        st.buf = ''; st.dirty = false;
      } else if (c === '\x7f' || c === '\b') st.buf = st.buf.slice(0, -1);
      else if (c === '\x15' || c === '\x03') { st.buf = ''; st.dirty = false; }
      else if (c === '\n') st.buf += '\n';
      else if (c >= ' ') st.buf += c;
    }
  }

  function attach(p) {
    if (!p.term) return;
    p.marks = { decos: [], scanned: 0, buf: '', dirty: false, timer: 0, full: false };
    panes.add(p);
    p.term.onWriteParsed(() => schedule(p));
    p.term.onResize(() => schedule(p, true));
  }
  // called from the pane's key handler (app.js); false means the key was used here
  function key(p, e) {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      jump(p, e.key === 'ArrowUp' ? -1 : 1);
      return false;
    }
    return true;
  }
  function detach(p) { if (p?.marks) { clear(p); clearTimeout(p.marks.timer); } panes.delete(p); }

  window.PromptMarks = {
    attach, detach, typed, key,
    sent: text => remember(text),
    known: list => { (list || []).forEach(t => remember(t, true)); panes.forEach(p => schedule(p, true)); },
    restyle: () => panes.forEach(p => schedule(p, true)),
    look,
  };
})();
