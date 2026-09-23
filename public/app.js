
const COLORS = { claude: '#d97757', codex: '#10a37f', grok: '#9aa2af', shell: '#7aa2f7', notes: '#e8b45a' };
// Per-kind dropdowns. Choices live in models.json on the server (refresh pulls them).
// mode 'slash':    types the slash command into the running session (no restart)
// mode 'relaunch': restarts the pane with the flag (codex/grok can't switch mid-session)
const KNOBS = {
  claude: [
    { mode: 'slash', cmd: '/model',  placeholder: 'model', list: 'models' },
    { mode: 'slash', cmd: '/effort', placeholder: 'effort', list: 'efforts' },
  ],
  codex: [
    { mode: 'relaunch', argTemplate: '-m {v}', placeholder: 'model', list: 'models' },
    { mode: 'relaunch', argTemplate: '-c model_reasoning_effort={v}', placeholder: 'effort', list: 'efforts' },
  ],
  grok: [
    { mode: 'relaunch', argTemplate: '-m {v}', placeholder: 'model', list: 'models' },
    { mode: 'relaunch', argTemplate: '--effort {v}', placeholder: 'effort', list: 'efforts' },
  ],
  shell: [],
  notes: [],
};
let modelsCfg = {}; // kind -> { models: [], efforts: [] }, from the server
const choicesFor = (kind, knob) => knob.choices || (modelsCfg[kind] || {})[knob.list] || [];
const THEME = { background: '#14202f', foreground: '#dce3ee', cursor: '#ffdf00', selectionBackground: '#33415580' };

const ICONS = {
  restart: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  image: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  send: '<svg class="i" viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
  info: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg>',
  copy: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  award: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/></svg>',
  scale: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2.5 5a3 3 0 0 0 5 0z"/><path d="M19 7l-2.5 5a3 3 0 0 0 5 0z"/><path d="M8 21h8"/></svg>',
  folder: '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  chain: '<svg class="i" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  note: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  promote: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20V5"/><path d="M6 11l6-6 6 6"/></svg>',
  compare: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/></svg>',
};

const ws = new WebSocket(`ws://${location.host}`);
const panes = new Map(); // instance id -> pane object (insertion order = layout order)
let roster = [], maxPanes = 5, history = [], histIdx = -1, playbooks = [], pipelines = [];
let cwd = '', recents = [], notesText = '', noteItems = [], rounds = [];
// a promoted answer becomes a mega-prompt in the bar; it's kept out of ↑/↓ history
const PROMOTE_HEAD = 'Continue from the winning answer below.';
const openCards = new Set(); // note ids the user expanded — survives rerenders

// note cards: newest on top, click to expand, headings ("Foo:") tinted amber
function renderNoteCards(pane) {
  const box = pane.cardsEl;
  if (!box) return;
  box.innerHTML = '';
  if (!noteItems.length) {
    box.innerHTML = '<div class="note-empty">no notes yet — hit &rarr; notes on any AI pane after it answers</div>';
    return;
  }
  [...noteItems].reverse().forEach(n => {
    const card = document.createElement('div');
    card.className = 'ncard' + (openCards.has(n.id) ? ' open' : '');
    const ts = new Date(n.ts);
    const when = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours() % 12 || 12)}:${String(ts.getMinutes()).padStart(2, '0')}${ts.getHours() < 12 ? 'am' : 'pm'}`;
    card.innerHTML = `
      <div class="ncard-head" style="color:${color(n.kind)}">
        <span class="ndot"></span>
        <span class="ntitle"></span>
        <span class="nwhen">${n.label} · ${when}</span>
        <button class="ncopy" title="copy note">${ICONS.copy}</button>
        <button class="ndel" title="delete note"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <svg class="nchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="ncard-body"></div>`;
    card.querySelector('.ntitle').textContent = n.title;
    const body = card.querySelector('.ncard-body');
    // plain text, but section headings ("Scores:", "Step details:") glow amber
    n.body.split('\n').forEach((line, i) => {
      if (i) body.appendChild(document.createTextNode('\n'));
      const sp = document.createElement('span');
      if (/^[A-Za-z][^:\n]{0,60}:\s*$/.test(line.trim())) sp.className = 'nh';
      sp.textContent = line;
      body.appendChild(sp);
    });
    card.querySelector('.ncard-head').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      card.classList.toggle('open');
      card.classList.contains('open') ? openCards.add(n.id) : openCards.delete(n.id);
    });
    card.querySelector('.ncopy').addEventListener('click', () => {
      navigator.clipboard.writeText(`${n.title}\n\n${n.body}`);
      toast('note copied', 'copy');
    });
    card.querySelector('.ndel').addEventListener('click', () => send({ type: 'noteDel', id: n.id }));
    box.appendChild(card);
  });
}
function renderAllNoteCards() { panes.forEach(p => renderNoteCards(p)); }
const $ = id => document.getElementById(id);
const promptEl = $('prompt'), panesEl = $('panes'), paneCountEl = $('paneCount');

function send(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function color(kind) { return COLORS[kind] || '#888'; }
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
function toast(text, icon) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = (ICONS[icon] || ICONS.info);
  t.appendChild(Object.assign(document.createElement('span'), { textContent: text }));
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// staged writes: a single "/model x" paste-chunk makes the slash menu
// filter on the whole string and miss; command, then arg, then Enter works
function slashCommand(paneId, cmd, arg) {
  send({ type: 'input', pane: paneId, data: cmd });
  setTimeout(() => send({ type: 'input', pane: paneId, data: ` ${arg}` }), 300);
  setTimeout(() => send({ type: 'input', pane: paneId, data: '\r' }), 600);
}

function buildPane(info) {
  const isNotes = info.kind === 'notes';
  const el = document.createElement('div');
  el.className = 'pane';
  el.innerHTML = `
    <div class="pane-head">
      <span class="dot" style="color:${color(info.kind)}"></span>
      <select class="cli" title="change this pane's CLI (new session)"></select>
      <span class="inst"></span>
      <span class="knobs"></span>
      <button class="yolo" title="skip permissions (dangerous) — toggling restarts this CLI">yolo</button>
      <span class="key"></span>
      <span class="spacer"></span>
      <span class="ctl">
        <button class="tn" title="turn this pane's last answer into plain-english next steps in the NOTES pane">&rarr; notes</button>
        <select class="relay" title="send this pane's last answer to another pane"><option value="">relay to</option></select>
        <button class="mv left" title="move pane left"><svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button class="mv right" title="move pane right"><svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        <button class="bc on" title="include in broadcast">bcast</button>
        <button class="rs" title="restart CLI">${ICONS.restart}</button>
        <button class="x" title="close pane (kills this CLI)"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </span>
    </div>
    ${isNotes
      ? `<div class="note-wrap">
           <div class="note-lb">scratch — autosaves</div>
           <textarea class="note-area" spellcheck="false" placeholder="type anything here"></textarea>
           <div class="note-split" title="drag to resize the scratch pad · double-click to reset"></div>
           <div class="note-cards"></div>
         </div>`
      : '<div class="term"></div>'}
    <div class="dead-cover">
      <span class="msg">session exited</span>
      <button class="dead-rs">${ICONS.restart}restart ${(info.label || '').toLowerCase()}</button>
    </div>`;
  panesEl.appendChild(el);

  if (isNotes) {
    // notepad pane: no PTY — a shared autosaving textarea (data/notes.md)
    ['.knobs', '.yolo', '.tn', '.relay', '.bc', '.rs'].forEach(sel => el.querySelector(sel)?.remove());
    const ta = el.querySelector('.note-area');
    ta.value = notesText;
    let saveTimer;
    ta.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => send({ type: 'notesSet', text: ta.value }), 500);
    });
    ta.addEventListener('focus', () => {
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('focused'));
      el.classList.add('focused');
    });
    ta.addEventListener('blur', () => el.classList.remove('focused'));
    // scratch/cards divider: drag up-down, remembered; double-click resets
    const SCRATCH_H = 'vibedeck-scratch-h';
    ta.style.height = (parseInt(localStorage.getItem(SCRATCH_H), 10) || 150) + 'px';
    const split = el.querySelector('.note-split');
    split.addEventListener('dblclick', () => {
      ta.style.height = '150px';
      localStorage.setItem(SCRATCH_H, '150');
    });
    split.addEventListener('mousedown', (e) => {
      e.preventDefault();
      split.classList.add('active');
      const startY = e.clientY, h0 = ta.offsetHeight;
      const wrap = el.querySelector('.note-wrap');
      const move = (ev) => {
        const h = Math.max(40, Math.min(wrap.clientHeight - 90, h0 + ev.clientY - startY));
        ta.style.height = h + 'px';
      };
      const up = () => {
        split.classList.remove('active');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        localStorage.setItem(SCRATCH_H, String(ta.offsetHeight));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    const pane = { term: null, fit: null, el, noteEl: ta, cardsEl: el.querySelector('.note-cards'),
                   broadcast: false, id: info.id, kind: info.kind, label: info.label, dead: false, knobSels: [] };
    renderNoteCards(pane);
    const cliSel = el.querySelector('.cli');
    cliSel.innerHTML = roster.map(r =>
      `<option value="${r.id}" ${r.id === info.kind ? 'selected' : ''}>${r.label}</option>`).join('');
    cliSel.style.color = color(info.kind);
    cliSel.addEventListener('change', () => {
      const target = cliSel.value;
      cliSel.value = info.kind;
      if (target !== info.kind) send({ type: 'replace', pane: info.id, kind: target });
    });
    const move = (dir) => {
      const order = [...panes.keys()];
      const i = order.indexOf(info.id), j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      send({ type: 'reorder', order });
    };
    el.querySelector('.mv.left').addEventListener('click', () => move(-1));
    el.querySelector('.mv.right').addEventListener('click', () => move(1));
    el.querySelector('.x').addEventListener('click', () => {
      if (panes.size > 1) send({ type: 'close', pane: info.id });
    });
    panes.set(info.id, pane);
    relayout();
    return;
  }

  const term = new Terminal({
    theme: THEME, fontSize: 13, lineHeight: 1.15,
    fontFamily: '"Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
    cursorBlink: true, scrollback: 8000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.term'));
  // WebGL renderer: the DOM renderer smears full-screen TUI redraws
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch (e) { console.warn('webgl unavailable', e); }
  fit.fit();

  term.onData(d => send({ type: 'input', pane: info.id, data: d }));
  term.textarea.addEventListener('focus', () => {
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('focused'));
    el.classList.add('focused');
  });
  term.textarea.addEventListener('blur', () => el.classList.remove('focused'));

  const pane = { term, fit, el, broadcast: true, id: info.id, kind: info.kind, label: info.label, dead: false };

  // CLI dropdown: picking a kind replaces this pane with a fresh instance of it
  const cliSel = el.querySelector('.cli');
  cliSel.innerHTML = roster.map(r =>
    `<option value="${r.id}" ${r.id === info.kind ? 'selected' : ''}>${r.label}</option>`).join('');
  cliSel.style.color = color(info.kind);
  cliSel.addEventListener('change', () => {
    const target = cliSel.value;
    cliSel.value = info.kind;
    if (target !== info.kind) send({ type: 'replace', pane: info.id, kind: target });
  });

  // move buttons: swap with the neighbor
  const move = (dir) => {
    const order = [...panes.keys()];
    const i = order.indexOf(info.id), j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    send({ type: 'reorder', order });
  };
  el.querySelector('.mv.left').addEventListener('click', () => move(-1));
  el.querySelector('.mv.right').addEventListener('click', () => move(1));

  // relay: pipe this pane's last answer into another pane
  const relaySel = el.querySelector('.relay');
  relaySel.addEventListener('change', () => {
    const to = relaySel.value;
    relaySel.value = '';
    if (to) send({ type: 'relay', pane: info.id, to });
  });

  // knob dropdowns (model, effort, …): slash-typed for claude, relaunch flags for codex/grok.
  // All relaunch knobs combine into one flag string so changing effort keeps the model choice.
  const knobsEl = el.querySelector('.knobs');
  const relaunchKnobs = [];
  pane.knobSels = [];
  const relaunchArgs = () => relaunchKnobs
    .map(({ knob, sel }) => sel.value ? knob.argTemplate.replace('{v}', sel.value) : '')
    .filter(Boolean).join(' ');
  for (const knob of KNOBS[info.kind] || []) {
    const sel = document.createElement('select');
    sel.className = 'opt';
    const storeKey = `vibedeck-${info.kind}-${(knob.cmd || knob.argTemplate).replace(/[^a-z]/gi, '')}`;
    const saved = localStorage.getItem(storeKey) || '';
    const choices = choicesFor(info.kind, knob);
    sel.innerHTML = `<option value="">${knob.placeholder}</option>`
      + choices.map(c => `<option value="${c}">${c}</option>`).join('');
    if (saved && choices.includes(saved)) sel.value = saved;
    if (knob.mode === 'relaunch') relaunchKnobs.push({ knob, sel });
    pane.knobSels.push({ knob, sel });
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (!v) return;
      if (knob.mode === 'relaunch') {
        send({ type: 'restart', pane: info.id, args: relaunchArgs() });
        localStorage.setItem(storeKey, v);
      } else {
        slashCommand(info.id, knob.cmd, v);
        localStorage.setItem(storeKey, v);
      }
    });
    knobsEl.appendChild(sel);
  }

  // images: drop onto the pane or paste (Ctrl+V) while it's focused — the
  // server saves the file and types its path into the CLI's input
  const sendImage = (file) => {
    if (!file || !file.type.startsWith('image/')) return false;
    const rd = new FileReader();
    rd.onload = () => send({ type: 'image', pane: info.id, name: file.name || 'pasted.png', data: rd.result });
    rd.readAsDataURL(file);
    return true;
  };
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dropping'); });
  el.addEventListener('dragleave', () => el.classList.remove('dropping'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dropping');
    [...(e.dataTransfer?.files || [])].forEach(sendImage);
  });
  term.textarea.addEventListener('paste', (e) => {
    const img = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (img && sendImage(img.getAsFile())) { e.preventDefault(); e.stopImmediatePropagation(); }
  });

  // yolo toggle: relaunch this pane with/without its CLI's skip-permissions flag
  const yoloBtn = el.querySelector('.yolo');
  pane.yolo = info.yolo !== false;
  const rosterEntry = roster.find(r => r.id === info.kind);
  if (rosterEntry && rosterEntry.hasYolo) {
    yoloBtn.title = `skip permissions — relaunches this CLI with ${rosterEntry.flags}`;
    yoloBtn.classList.toggle('on', pane.yolo);
    yoloBtn.addEventListener('click', () => send({ type: 'yolo', pane: info.id, on: !pane.yolo }));
  } else {
    yoloBtn.remove(); // shell has no permissions concept
  }

  const bcBtn = el.querySelector('.bc');
  bcBtn.classList.toggle('on', pane.broadcast);
  bcBtn.addEventListener('click', () => {
    pane.broadcast = !pane.broadcast;
    bcBtn.classList.toggle('on', pane.broadcast);
  });
  el.querySelector('.tn').addEventListener('click', () => send({ type: 'toNotes', pane: info.id }));
  const doRestart = () => send({ type: 'restart', pane: info.id });
  el.querySelector('.rs').addEventListener('click', doRestart);
  el.querySelector('.dead-rs').addEventListener('click', doRestart);
  el.querySelector('.x').addEventListener('click', () => {
    if (panes.size > 1) send({ type: 'close', pane: info.id });
  });
  panes.set(info.id, pane);
  relayout();
}

function removePane(id) {
  const p = panes.get(id);
  if (!p) return;
  p.term?.dispose();
  p.el.remove();
  panes.delete(id);
  relayout();
}

function applyOrder(order) {
  const entries = order.map(id => [id, panes.get(id)]).filter(([, p]) => p);
  panes.clear();
  for (const [id, p] of entries) {
    panes.set(id, p);
    panesEl.appendChild(p.el); // append in order = visual order
  }
  relayout();
}

function paneTitle(p) {
  const dupes = [...panes.values()].filter(x => x.kind === p.kind);
  const n = dupes.indexOf(p) + 1;
  return p.label + (dupes.length > 1 ? ` #${n}` : '');
}

// ---- adjustable pane sizes: draggable splitters, fractions saved per layout ----
let frac = { cols: [], rows: [] };
function applySplitTemplate() {
  panesEl.style.gridTemplateColumns = frac.cols.map(f => f + 'fr').join(' 6px ');
  panesEl.style.gridTemplateRows = frac.rows.map(f => f + 'fr').join(' 6px ');
}
function addSplitter(axis, idx, storeKey, gridColumn, gridRow) {
  const el = document.createElement('div');
  el.className = `split split-${axis}`;
  el.style.gridColumn = gridColumn;
  el.style.gridRow = gridRow;
  el.title = 'drag to resize · double-click to reset';
  el.addEventListener('dblclick', () => {
    const arr = axis === 'col' ? frac.cols : frac.rows;
    arr.fill(1);
    applySplitTemplate();
    localStorage.setItem(storeKey, JSON.stringify(frac));
    setTimeout(fitAll, 50);
  });
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el.classList.add('active');
    const arr = axis === 'col' ? frac.cols : frac.rows;
    const start = axis === 'col' ? e.clientX : e.clientY;
    const a0 = arr[idx], b0 = arr[idx + 1];
    const totalPx = axis === 'col' ? panesEl.clientWidth : panesEl.clientHeight;
    const totalFr = arr.reduce((s, x) => s + x, 0);
    const move = (ev) => {
      const d = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / totalPx * totalFr;
      arr[idx] = Math.max(0.15, a0 + d);
      arr[idx + 1] = Math.max(0.15, b0 - d);
      applySplitTemplate();
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitAll, 80);
    };
    const up = () => {
      el.classList.remove('active');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem(storeKey, JSON.stringify(frac));
      fitAll();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  panesEl.appendChild(el);
}

function relayout() {
  const n = panes.size;
  const all = [...panes.values()];
  panesEl.querySelectorAll('.split').forEach(s => s.remove());
  const storeKey = `vibedeck-split-${n}`;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storeKey)); } catch {}
  if (n <= 3) {
    frac = (saved && saved.cols?.length === n) ? saved : { cols: Array(n).fill(1), rows: [1] };
    frac.rows = [1];
    applySplitTemplate();
    all.forEach((p, i) => { p.el.style.gridColumn = String(1 + i * 2); p.el.style.gridRow = '1'; });
    for (let i = 0; i < n - 1; i++) addSplitter('col', i, storeKey, String(2 + i * 2), '1');
  } else if (n === 4) {
    frac = (saved && saved.cols?.length === 2 && saved.rows?.length === 2) ? saved : { cols: [1, 1], rows: [1, 1] };
    applySplitTemplate();
    const pos = [[1, 1], [3, 1], [1, 3], [3, 3]]; // [col, row]
    all.forEach((p, i) => { p.el.style.gridColumn = String(pos[i][0]); p.el.style.gridRow = String(pos[i][1]); });
    addSplitter('col', 0, storeKey, '2', '1 / -1');
    addSplitter('row', 0, storeKey, '1 / -1', '2');
  } else {
    // 5 panes: 3 up top, 2 below — bottom-left spans two tracks so the last
    // pane (usually NOTES) gets the right-hand column
    frac = (saved && saved.cols?.length === 3 && saved.rows?.length === 2) ? saved : { cols: [1, 1, 1], rows: [1, 1] };
    applySplitTemplate();
    const pos = [['1', '1'], ['3', '1'], ['5', '1'], ['1 / 4', '3'], ['5', '3']]; // [gridColumn, gridRow]
    all.forEach((p, i) => { p.el.style.gridColumn = pos[i][0]; p.el.style.gridRow = pos[i][1]; });
    addSplitter('col', 0, storeKey, '2', '1');       // top row only — bottom-left spans across it
    addSplitter('col', 1, storeKey, '4', '1 / -1');  // splits top 2|3 and bottom left|right
    addSplitter('row', 0, storeKey, '1 / -1', '2');
  }
  const kindCounts = {};
  all.forEach(p => { kindCounts[p.kind] = (kindCounts[p.kind] || 0) + 1; });
  const kindSeen = {};
  all.forEach((p, i) => {
    p.el.querySelector('.key').textContent = `ctrl+${i + 1}`;
    kindSeen[p.kind] = (kindSeen[p.kind] || 0) + 1;
    p.el.querySelector('.inst').textContent = kindCounts[p.kind] > 1 ? `#${kindSeen[p.kind]}` : '';
    // rebuild relay targets (all other panes that can receive typed prompts)
    const relaySel = p.el.querySelector('.relay');
    if (relaySel) relaySel.innerHTML = '<option value="">relay to</option>' + all.filter(x => x !== p && x.kind !== 'notes')
      .map(x => `<option value="${x.id}">${paneTitle(x)}</option>`).join('');
  });
  paneCountEl.value = String(n);
  setTimeout(fitAll, 50);
}

// pane count: grow by adding CLIs (unused kinds first, then more claudes), shrink from the right
paneCountEl.addEventListener('change', () => {
  const want = Number(paneCountEl.value), cur = panes.size;
  if (want > cur) {
    const activeKinds = new Set([...panes.values()].map(p => p.kind));
    const fresh = roster.filter(r => r.id !== 'shell' && r.id !== 'notes' && !activeKinds.has(r.id)).map(r => r.id);
    for (let i = 0; i < want - cur; i++) send({ type: 'add', kind: fresh.shift() || 'claude' });
  } else if (want < cur) {
    [...panes.values()].slice(want).forEach(p => send({ type: 'close', pane: p.id }));
  }
  promptEl.focus();
});

// ---------- websocket ----------
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'init') {
    roster = msg.roster; maxPanes = msg.maxPanes;
    history = msg.history || []; playbooks = msg.playbooks || [];
    pipelines = msg.pipelines || [];
    modelsCfg = msg.models || {};
    notesText = msg.notes || '';
    noteItems = msg.noteItems || [];
    rounds = msg.rounds || [];
    renderAllNoteCards();
    setHealth(msg.health || []);
    setJudges(msg.judges || []);
    setCwd(msg.cwd || '', msg.recents || []);
    setPlaybooks();
    setPipelines();
    if (!panes.size) msg.panes.forEach(p => buildPane(p));
    setTimeout(nudgeAll, 600); // repaint after scrollback replay
  } else if (msg.type === 'data') {
    panes.get(msg.pane)?.term?.write(msg.data);
  } else if (msg.type === 'exit') {
    const p = panes.get(msg.pane);
    if (p) { p.dead = true; p.el.classList.add('dead'); p.term?.write('\r\n\x1b[31m[exited — hit restart]\x1b[0m\r\n'); }
  } else if (msg.type === 'restarted') {
    const p = panes.get(msg.pane);
    if (p && p.term) {
      p.dead = false;
      p.el.classList.remove('dead');
      p.term.reset();
      send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows });
    }
  } else if (msg.type === 'paneAdded') {
    if (!panes.has(msg.pane.id)) buildPane(msg.pane);
    setTimeout(() => nudgeOne(panes.get(msg.pane.id)), 400);
  } else if (msg.type === 'paneRemoved') {
    removePane(msg.pane);
  } else if (msg.type === 'reordered') {
    applyOrder(msg.order);
  } else if (msg.type === 'paneReplaced') {
    removePane(msg.old);
    if (!panes.has(msg.pane.id)) buildPane(msg.pane);
    applyOrder(msg.order);
    setTimeout(() => nudgeOne(panes.get(msg.pane.id)), 400);
  } else if (msg.type === 'yolo') {
    const p = panes.get(msg.pane);
    if (p) {
      p.yolo = msg.on;
      p.el.querySelector('.yolo')?.classList.toggle('on', msg.on);
      toast(`${paneTitle(p)} restarting ${msg.on ? 'WITH skip-permissions' : 'with permission prompts back on'}`);
    }
  } else if (msg.type === 'imageSaved') {
    const p = panes.get(msg.pane);
    toast(`${msg.file} sent to ${p ? paneTitle(p) : msg.pane} — path typed into its input`, 'image');
  } else if (msg.type === 'relayed') {
    const from = panes.get(msg.from), to = panes.get(msg.to);
    toast(`relayed ${from ? paneTitle(from) : '?'} to ${to ? paneTitle(to) : '?'}`, 'send');
  } else if (msg.type === 'roundStarted') {
    // dots pulse while a pane is still answering; a fresh round supersedes the old one
    document.querySelectorAll('.pane-head .dot').forEach(d => d.classList.remove('busy'));
    (msg.targets || []).forEach(id => panes.get(id)?.el.querySelector('.dot')?.classList.add('busy'));
  } else if (msg.type === 'answerDone') {
    panes.get(msg.pane)?.el.querySelector('.dot')?.classList.remove('busy');
  } else if (msg.type === 'roundDone') {
    document.querySelectorAll('.pane-head .dot').forEach(d => d.classList.remove('busy'));
    $('cmpBtn').classList.add('glow');
    toast(msg.count > 1 ? 'all answers in — hit compare' : 'answer in — hit compare', 'send');
  } else if (msg.type === 'hist') {
    history.push(msg.item);
  } else if (msg.type === 'round') {
    renderCompare(msg);
  } else if (msg.type === 'roundSaved') {
    rounds.push(msg.round);
    refreshRoundsTab();
  } else if (msg.type === 'crowned') {
    const r = rounds.find(x => x.ts === msg.ts);
    if (r) r.winnerKind = msg.kind;
    refreshRoundsTab();
  } else if (msg.type === 'judging') {
    const v = $('verdict');
    v.classList.add('open');
    v.innerHTML = `<div class="v-head">${ICONS.scale}JUDGE <span class="jk"></span></div>reading all the answers… (can take a minute)`;
    v.querySelector('.jk').textContent = judgeTag(msg.kind);
  } else if (msg.type === 'judgement') {
    const v = $('verdict');
    v.classList.add('open');
    v.innerHTML = `<div class="v-head">${ICONS.scale}VERDICT <span class="jk"></span></div>`;
    v.querySelector('.jk').textContent = judgeTag(msg.kind);
    v.appendChild(Object.assign(document.createElement('span'), { textContent: msg.text }));
  } else if (msg.type === 'playbooks') {
    playbooks = msg.items || [];
    setPlaybooks();
  } else if (msg.type === 'pipelines') {
    pipelines = msg.items || [];
    setPipelines();
  } else if (msg.type === 'modelsUpdating') {
    toast('refreshing model lists — watch the /model menus flash', 'restart');
  } else if (msg.type === 'models') {
    modelsCfg = msg.config || {};
    repopulateKnobs();
    toast(`models: ${msg.report}`);
    if (applyLatestPending) { applyLatestPending = false; applyLatestModels(); }
  } else if (msg.type === 'notes') {
    notesText = msg.text || '';
    panes.forEach(p => {
      if (p.noteEl && document.activeElement !== p.noteEl) p.noteEl.value = notesText;
    });
  } else if (msg.type === 'notesWorking') {
    toast('writing plain-english steps to the notepad… (takes ~15s)', 'note');
  } else if (msg.type === 'noteItems') {
    noteItems = msg.items || [];
    renderAllNoteCards();
  } else if (msg.type === 'notesAppended') {
    const from = panes.get(msg.from);
    toast(msg.ok ? `note from ${from ? paneTitle(from) : '?'} added — click it to expand`
                 : `couldn't rewrite it — raw answer saved as a note instead`, 'note');
    panes.forEach(p => { if (p.cardsEl) p.cardsEl.scrollTop = 0; });
  } else if (msg.type === 'notesError') {
    toast(msg.text, 'note');
  } else if (msg.type === 'cwdChanged') {
    setCwd(msg.cwd, msg.recents || recents);
    $('cwdPanel').classList.remove('open');
    $('cwdBtn').classList.remove('open');
    toast(`deck relaunched in ${msg.cwd}`, 'folder');
  } else if (msg.type === 'cwdError') {
    toast(msg.text || 'that folder does not exist', 'folder');
  } else if (msg.type === 'pipeline') {
    const chip = $('pipeChip');
    if (msg.state === 'step') {
      // a pipeline supersedes any broadcast round still being watched
      document.querySelectorAll('.pane-head .dot').forEach(d => d.classList.remove('busy'));
      chip.classList.add('on');
      chip.querySelector('.pc-text').textContent = `${msg.name} · ${msg.step + 1}/${msg.total} · ${msg.label}`;
    } else {
      chip.classList.remove('on');
      if (msg.state === 'done') toast(`${msg.name} — done. Last pane has the final answer.`, 'chain');
      else toast(`${msg.name} — ${msg.state}${msg.text ? ': ' + msg.text : ''}`, 'chain');
    }
  }
};
ws.onclose = () => {
  $('reconnect').classList.add('open');
  panes.forEach(p => p.term?.write('\r\n\x1b[31m[server disconnected]\x1b[0m\r\n'));
  const retry = setInterval(async () => {
    try { await fetch('/', { cache: 'no-store' }); clearInterval(retry); location.reload(); } catch {}
  }, 2000);
};

// ---------- project folder ----------
function setCwd(dir, rec) {
  cwd = dir; recents = rec;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  $('cwdBtn').querySelector('.nm').textContent = parts[parts.length - 1] || dir || '—';
  $('cwdBtn').title = `project folder — ${dir}`;
  $('cwdCur').textContent = dir;
  $('cwdRecents').innerHTML = '';
  recents.filter(r => r !== dir).slice(0, 7).forEach(r => {
    const d = document.createElement('div');
    d.className = 'r-item';
    d.innerHTML = ICONS.folder + '<span class="p"></span>';
    d.querySelector('.p').textContent = r;
    d.addEventListener('click', () => send({ type: 'setcwd', dir: r }));
    $('cwdRecents').appendChild(d);
  });
  if (!recents.filter(r => r !== dir).length)
    $('cwdRecents').innerHTML = '<div class="r-item" style="cursor:default;color:var(--faint)">no other folders yet</div>';
}
$('cwdBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !$('cwdPanel').classList.contains('open');
  $('cwdPanel').classList.toggle('open', open);
  $('cwdBtn').classList.toggle('open', open);
  if (open) { $('cwdInput').value = ''; $('cwdInput').focus(); }
});
document.addEventListener('click', (e) => {
  if (!$('cwdPanel').contains(e.target) && e.target !== $('cwdBtn')) {
    $('cwdPanel').classList.remove('open');
    $('cwdBtn').classList.remove('open');
  }
});
const goCwd = () => { const d = $('cwdInput').value.trim(); if (d) send({ type: 'setcwd', dir: d }); };
$('cwdGo').addEventListener('click', goCwd);
$('cwdInput').addEventListener('keydown', e => { if (e.key === 'Enter') goCwd(); });

// ---------- cli health ----------
const CLI_HINTS = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  grok: 'Grok CLI not found (expected ~\\.grok\\bin\\grok.exe)',
};
function setHealth(list) {
  const strip = $('healthStrip'), box = strip.querySelector('.hs-items');
  const missing = list.filter(h => !h.ok);
  box.innerHTML = '';
  if (!missing.length) { strip.classList.remove('open'); return; }
  missing.forEach(h => {
    const row = document.createElement('span');
    row.className = 'hs-item';
    row.innerHTML = '<b></b> missing — <span class="hint"></span>';
    row.querySelector('b').textContent = h.label || String(h.id || '').toUpperCase();
    row.querySelector('.hint').textContent = CLI_HINTS[h.id] || h.detail || '';
    box.appendChild(row);
  });
  strip.classList.add('open');
}
$('healthStrip').querySelector('.hs-x').addEventListener('click', () => $('healthStrip').classList.remove('open'));

// ---------- playbooks ----------
const playbookEl = $('playbook');
function setPlaybooks() {
  playbookEl.innerHTML = '<option value="">playbook</option>'
    + playbooks.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
}
playbookEl.addEventListener('change', () => {
  const p = playbooks[Number(playbookEl.value)];
  playbookEl.value = '';
  if (!p) return;
  promptEl.value = p.text + (p.text.endsWith(':') ? ' ' : '');
  sizePrompt();
  promptEl.focus();
  promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
});
playbookEl.addEventListener('mousedown', () => send({ type: 'playbooks' }));

// ---------- meter sidebar (far right, toggleable, remembered) ----------
const meterBar = $('meterbar');
const meterFrame = $('meterframe');
function setMeter(open) {
  if (open && !meterFrame.src) meterFrame.src = '/meter'; // lazy-load: no polling while closed
  meterBar.classList.toggle('open', open);
  $('meterBtn').classList.toggle('on', open);
  localStorage.setItem('vibedeck-meterbar', open ? '1' : '0');
}
$('meterBtn').addEventListener('click', () => setMeter(!meterBar.classList.contains('open')));
if (localStorage.getItem('vibedeck-meterbar') === '1') setMeter(true);

// ---------- models refresh ----------
function repopulateKnobs() {
  panes.forEach(p => (p.knobSels || []).forEach(({ knob, sel }) => {
    const cur = sel.value;
    const choices = choicesFor(p.kind, knob);
    sel.innerHTML = `<option value="">${knob.placeholder}</option>`
      + choices.map(c => `<option value="${c}">${c}</option>`).join('');
    if (choices.includes(cur)) sel.value = cur;
  }));
}
// update models = refresh the lists from the CLIs, then jump every pane to the
// newest model in its list (claude via /model in-session; codex/grok relaunch)
let applyLatestPending = false;
$('modelsBtn').addEventListener('click', () => {
  applyLatestPending = true;
  send({ type: 'updateModels' });
});
function applyLatestModels() {
  const moved = [];
  panes.forEach(p => (p.knobSels || []).forEach(({ knob, sel }) => {
    if (knob.list !== 'models') return;
    const choices = choicesFor(p.kind, knob);
    if (!choices.length || sel.value === choices[0]) return;
    sel.value = choices[0];
    sel.dispatchEvent(new Event('change')); // same path as picking it by hand
    moved.push(`${paneTitle(p)} → ${choices[0]}`);
  }));
  if (moved.length) toast(`switched to latest: ${moved.join(' · ')}`, 'restart');
  else toast('every pane is already on the newest model');
}

// ---------- pipelines ----------
const pipelineEl = $('pipeline');
function setPipelines() {
  pipelineEl.innerHTML = '<option value="">pipeline</option>'
    + pipelines.map((p, i) => `<option value="${i}">${p.name} (${p.steps.join(' → ')})</option>`).join('');
}
pipelineEl.addEventListener('change', () => {
  const p = pipelines[Number(pipelineEl.value)];
  pipelineEl.value = '';
  if (!p) return;
  const prompt = promptEl.value.trim();
  if (!prompt) { toast('type a prompt first, then pick a pipeline', 'chain'); promptEl.focus(); return; }
  send({ type: 'pipeline', name: p.name, prompt }); // server adds it to history and echoes 'hist' back
  histIdx = -1;
  promptEl.value = '';
  sizePrompt();
});
pipelineEl.addEventListener('mousedown', () => send({ type: 'pipelines' }));
$('pipeChip').querySelector('.pc-x').addEventListener('click', () => send({ type: 'pipelineCancel' }));

// ---------- history ----------
let histTab = 'prompts';
function renderHistory(filter) {
  histTab === 'rounds' ? renderRounds(filter) : renderPrompts(filter);
}
function refreshRoundsTab() {
  if (histTab === 'rounds' && $('histOverlay').classList.contains('open')) renderRounds($('histSearch').value);
}
function renderPrompts(filter) {
  const list = $('histList');
  list.innerHTML = '';
  const f = (filter || '').toLowerCase();
  const items = [...history].reverse().filter(h => !f || h.text.toLowerCase().includes(f));
  items.forEach(h => {
    const d = document.createElement('div');
    d.className = 'h-item';
    const ts = new Date(h.ts);
    const when = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
    d.innerHTML = `<span class="h-ts">${when}</span><span class="h-text"></span><button class="h-del" title="delete"><svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    d.querySelector('.h-text').textContent = h.text;
    d.addEventListener('click', () => {
      promptEl.value = h.text;
      sizePrompt();
      $('histOverlay').classList.remove('open');
      promptEl.focus();
    });
    d.querySelector('.h-del').addEventListener('click', (e) => {
      e.stopPropagation();
      send({ type: 'histdel', ts: h.ts });
      history = history.filter(x => x.ts !== h.ts);
      d.remove();
    });
    list.appendChild(d);
  });
  if (!items.length) list.innerHTML = `<div class="h-item" style="cursor:default;color:var(--faint)">${f ? 'nothing matches' : 'no prompts yet — broadcast something'}</div>`;
}
// rounds tab: one row per saved broadcast, with every model that answered
function renderRounds(filter) {
  const list = $('histList');
  list.innerHTML = '';
  const f = (filter || '').toLowerCase();
  const items = [...rounds].reverse().filter(r => !f || (r.prompt || '').toLowerCase().includes(f));
  items.forEach(r => {
    const d = document.createElement('div');
    d.className = 'h-item';
    const ts = new Date(r.ts);
    const when = `${ts.getMonth() + 1}/${ts.getDate()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`;
    d.innerHTML = `<span class="h-ts">${when}</span><span class="h-text"></span><span class="h-chips"></span>`
      + `<button class="h-cmp" title="reopen this round side by side">${ICONS.compare}compare</button>`;
    d.querySelector('.h-text').textContent = r.prompt || '';
    const chips = d.querySelector('.h-chips');
    (r.responses || []).forEach(resp => {
      const won = !!r.winnerKind && r.winnerKind === resp.kind;
      const chip = document.createElement('span');
      chip.className = 'chip' + (won ? ' win' : '');
      if (won) chip.innerHTML = ICONS.award;
      else chip.style.color = color(resp.kind);
      chip.appendChild(Object.assign(document.createElement('span'), { textContent: resp.label || resp.kind }));
      chips.appendChild(chip);
    });
    d.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      promptEl.value = r.prompt || '';
      sizePrompt();
      $('histOverlay').classList.remove('open');
      promptEl.focus();
    });
    d.querySelector('.h-cmp').addEventListener('click', () => {
      $('histOverlay').classList.remove('open');
      renderCompare(r);
    });
    list.appendChild(d);
  });
  if (!items.length) list.innerHTML = `<div class="h-item" style="cursor:default;color:var(--faint)">${f ? 'nothing matches' : 'no rounds yet — broadcast something and let the models answer'}</div>`;
}
$('histTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  histTab = b.dataset.tab;
  $('histTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  $('histSearch').placeholder = histTab === 'rounds' ? 'filter rounds' : 'filter prompts';
  $('histOverlay').querySelector('.ov-prompt').textContent = histTab === 'rounds'
    ? 'click a round to reload its prompt · compare reopens every answer'
    : 'click a prompt to load it into the bar';
  renderHistory($('histSearch').value);
});
$('histBtn').addEventListener('click', () => {
  $('histSearch').value = '';
  renderHistory();
  $('histOverlay').classList.add('open');
  $('histSearch').focus();
});
$('histSearch').addEventListener('input', () => renderHistory($('histSearch').value));
$('histClose').addEventListener('click', () => $('histOverlay').classList.remove('open'));

// ---------- shortcuts help ----------
$('helpBtn').addEventListener('click', () => $('helpOverlay').classList.add('open'));
$('helpClose').addEventListener('click', () => $('helpOverlay').classList.remove('open'));

// ---------- compare + judge ----------
const WINS_KEY = 'vibedeck-wins';
const getWins = () => { try { return JSON.parse(localStorage.getItem(WINS_KEY)) || {}; } catch { return {}; } };
$('cmpBtn').addEventListener('click', () => { $('cmpBtn').classList.remove('glow'); send({ type: 'round' }); });
$('cmpClose').addEventListener('click', () => $('cmpOverlay').classList.remove('open'));

const JUDGE_KEY = 'vibedeck-judge';
const judgeKindEl = $('judgeKind');
function setJudges(list) {
  judgeKindEl.innerHTML = list.map(k => `<option value="${k}">${k.toUpperCase()}</option>`).join('');
  judgeKindEl.style.display = list.length ? '' : 'none';
  const saved = localStorage.getItem(JUDGE_KEY);
  if (saved && list.includes(saved)) judgeKindEl.value = saved;
}
const judgeTag = (kind) => kind ? `(${String(kind).toUpperCase()})` : '';
judgeKindEl.addEventListener('change', () => localStorage.setItem(JUDGE_KEY, judgeKindEl.value));
$('judgeBtn').addEventListener('click', () => send({ type: 'judge', kind: judgeKindEl.value }));

function renderCompare(round) {
  const cols = $('cmpCols');
  cols.innerHTML = '';
  $('verdict').classList.remove('open');
  $('cmpPrompt').textContent = round.prompt || 'nothing yet — broadcast a prompt first, let the models answer, then hit compare';
  const wins = getWins();
  const rs = (round.responses || []).filter(r => r.text);
  cols.style.gridTemplateColumns = `repeat(${Math.max(rs.length, 1)}, 1fr)`;
  if (!rs.length) {
    cols.innerHTML = '<div class="cmp-col"><div class="cmp-body">No answers captured yet. Broadcast something, give the models a minute, then come back.</div></div>';
  }
  rs.forEach(r => {
    const col = document.createElement('div');
    col.className = 'cmp-col';
    col.style.borderTopColor = color(r.kind);
    col.innerHTML = `
      <div class="col-head" style="color:${color(r.kind)}">
        ${r.label}<span class="wins">${wins[r.kind] ? wins[r.kind] + ' wins' : ''}</span>
        <span class="spacer"></span>
        <button class="copy">${ICONS.copy}copy</button>
        <button class="promote" title="carry this answer into the prompt bar and keep going from it">${ICONS.promote}promote</button>
        <button class="win">${ICONS.award}winner</button>
      </div>
      <div class="cmp-body"></div>`;
    col.querySelector('.cmp-body').textContent = r.text;
    if (round.winnerKind === r.kind) col.classList.add('winner');
    col.querySelector('.copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(r.text);
      const b = e.currentTarget;
      b.childNodes[b.childNodes.length - 1].textContent = 'copied';
      setTimeout(() => b.childNodes[b.childNodes.length - 1].textContent = 'copy', 1500);
    });
    col.querySelector('.promote').addEventListener('click', () => {
      promptEl.value = `${PROMOTE_HEAD} Original prompt:\n${round.prompt}\n\nWinner (${r.label}):\n${r.text}\n\nNext: `;
      sizePrompt();
      $('cmpOverlay').classList.remove('open');
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    });
    col.querySelector('.win').addEventListener('click', () => {
      const w = getWins();
      w[r.kind] = (w[r.kind] || 0) + 1;
      localStorage.setItem(WINS_KEY, JSON.stringify(w));
      cols.querySelectorAll('.cmp-col').forEach(c => c.classList.remove('winner'));
      col.classList.add('winner');
      col.querySelector('.wins').textContent = `${w[r.kind]} wins`;
      if (round.ts) send({ type: 'crown', ts: round.ts, kind: r.kind });
    });
    cols.appendChild(col);
  });
  $('cmpOverlay').classList.add('open');
}

// ---------- prompt bar (textarea: Enter sends, Shift+Enter = new line) ----------
function sizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 130) + 'px';
}
promptEl.addEventListener('input', sizePrompt);
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault(); // even when empty — don't let Enter add a stray blank line
    const text = promptEl.value;
    if (!text.trim()) return;
    const targets = [...panes.values()].filter(p => p.broadcast).map(p => p.id);
    const out = { type: 'broadcast', data: text, targets }; // server adds it to history and echoes 'hist' back
    if (text.startsWith(PROMOTE_HEAD)) out.noHist = true; // rounds already keep these
    send(out);
    histIdx = -1;
    promptEl.value = '';
    sizePrompt();
  } else if (e.key === 'ArrowUp' && !promptEl.value.slice(0, promptEl.selectionStart).includes('\n')) {
    e.preventDefault(); // only on the first line — otherwise the caret is just moving up
    if (!history.length) return;
    histIdx = Math.min(histIdx + 1, history.length - 1);
    promptEl.value = history[history.length - 1 - histIdx].text;
    sizePrompt();
  } else if (e.key === 'ArrowDown' && !promptEl.value.slice(promptEl.selectionEnd).includes('\n')) {
    e.preventDefault();
    histIdx = Math.max(histIdx - 1, -1);
    promptEl.value = histIdx === -1 ? '' : history[history.length - 1 - histIdx].text;
    sizePrompt();
  }
});

// ---------- terminal plumbing ----------
function fitAll() {
  panes.forEach(p => {
    if (!p.term) return;
    try {
      p.fit.fit();
      send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows });
    } catch {}
  });
}
// shrink-then-restore forces full-screen TUIs to repaint cleanly
function nudgeOne(p) {
  if (!p || !p.term) return;
  send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows - 1 });
  setTimeout(() => {
    send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows });
    p.term.scrollToBottom();
  }, 120);
}
function nudgeAll() { fitAll(); panes.forEach(nudgeOne); }

let fitTimer;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitAll, 100);
}).observe(panesEl);

// global shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    for (const id of ['cmpOverlay', 'histOverlay', 'helpOverlay']) {
      if ($(id).classList.contains('open')) { $(id).classList.remove('open'); return; }
    }
    if ($('cwdPanel').classList.contains('open')) {
      $('cwdPanel').classList.remove('open');
      $('cwdBtn').classList.remove('open');
      return;
    }
  }
  if (e.ctrlKey && ['1', '2', '3', '4', '5'].includes(e.key)) {
    e.preventDefault();
    const pane = [...panes.values()][Number(e.key) - 1];
    (pane?.term || pane?.noteEl)?.focus();
  } else if (e.ctrlKey && e.key === '0') {
    // Ctrl+0 returns to the prompt bar (Esc stays free — the CLIs use it to interrupt)
    e.preventDefault();
    promptEl.focus();
  }
});
