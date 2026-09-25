// VibeDeck workbench core: terminal panes, broadcast rounds, compare + judge, project folder.
// shell.js, history.js, pipeline.js and connections.js build on the globals defined here.

const COLORS = { claude: '#d97757', codex: '#10a37f', grok: '#9aa4b5', shell: '#7aa2f7', notes: '#c9a4f0', api: '#c4a35a' };
const KIND_NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok', shell: 'Shell', notes: 'Notes', api: 'API' };
// Per-kind dropdowns. Choices live in models.json on the server.
// mode 'slash':    types the slash command into the running session (no restart)
// mode 'relaunch': restarts the pane with the flag (codex/grok can't switch mid-session)
const KNOBS = {
  claude: [
    { mode: 'slash', cmd: '/model', placeholder: 'model', list: 'models' },
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
  shell: [], notes: [],
};
let modelsCfg = {};
const choicesFor = (kind, knob) => knob.choices || (modelsCfg[kind] || {})[knob.list] || [];
const THEME = {
  background: '#0e1118', foreground: '#d4d9e3', cursor: '#ffd400', cursorAccent: '#0e1118',
  selectionBackground: '#ffd40040', black: '#0e1118', brightBlack: '#626a7c',
};

const svg = d => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  restart: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
  send: svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/>'),
  warn: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17h.01"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  award: svg('<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>'),
  scale: svg('<path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-2.5 5a3 3 0 0 0 5 0z"/><path d="M19 7l-2.5 5a3 3 0 0 0 5 0z"/><path d="M8 21h8"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  chain: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  note: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  promote: svg('<path d="M12 20V5"/><path d="M6 11l6-6 6 6"/>'),
  compare: svg('<rect x="3" y="4" width="7.5" height="16" rx="1.5"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.5"/>'),
  radio: svg('<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  swap: svg('<path d="M7 7h13l-4-4M17 17H4l4 4"/>'),
  sidecar: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>'),
  chev: svg('<path d="M6 9l6 6 6-6"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  play: svg('<path d="M7 4l13 8-13 8z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  arrow: svg('<path d="M4 12h15M13 6l6 6-6 6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>'),
  terminal: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
};

const ws = new WebSocket(`ws://${location.host}`);
const panes = new Map(); // instance id -> pane object (insertion order = layout order)
let roster = [], maxPanes = 5, history = [], histIdx = -1, playbooks = [];
let cwd = '', recents = [], home = '', notesText = '', noteItems = [], rounds = [];
let desktop = false, needsFolder = false, roundActive = false;
// a promoted answer becomes a mega-prompt in the bar; it's kept out of Up/Down history
const PROMOTE_HEAD = 'Continue from the winning answer below.';
const openCards = new Set(); // note ids the user expanded, survives rerenders

const $ = id => document.getElementById(id);
const promptEl = $('prompt'), panesEl = $('panes');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function send(msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function color(kind) { return COLORS[kind] || '#888'; }
function kindName(kind) { return KIND_NAMES[kind] || kind; }
function toast(text, icon, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.innerHTML = ICONS[icon] || (bad ? ICONS.warn : ICONS.info);
  t.appendChild(Object.assign(document.createElement('span'), { textContent: text }));
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3600);
}
const fmtClock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtWhen = ts => {
  const d = new Date(ts), now = new Date();
  const t = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;
  return d.toDateString() === now.toDateString() ? `Today ${t}` : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
};

// staged writes: a single "/model x" paste-chunk makes the slash menu
// filter on the whole string and miss; command, then arg, then Enter works
function slashCommand(paneId, cmd, arg) {
  send({ type: 'input', pane: paneId, data: cmd });
  setTimeout(() => send({ type: 'input', pane: paneId, data: ` ${arg}` }), 300);
  setTimeout(() => send({ type: 'input', pane: paneId, data: '\r' }), 600);
}

// ---------- note cards (NOTES pane) ----------
function renderNoteCards(pane) {
  const box = pane.cardsEl;
  if (!box) return;
  box.innerHTML = '';
  if (!noteItems.length) {
    box.innerHTML = '<div class="note-empty">No notes yet. Use "Send answer to Notes" from any AI pane\'s menu after it answers.</div>';
    return;
  }
  [...noteItems].reverse().forEach(n => {
    const card = document.createElement('div');
    card.className = 'ncard' + (openCards.has(n.id) ? ' open' : '');
    card.innerHTML = `
      <div class="ncard-head" style="color:${color(n.kind)}">
        <span class="ndot"></span><span class="ntitle"></span>
        <span class="nwhen">${esc(kindName(n.kind))}, ${esc(fmtWhen(n.ts))}</span>
        <button class="ncopy" title="Copy note">${ICONS.copy}</button>
        <button class="ndel" title="Delete note">${ICONS.x}</button>
        <svg class="nchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="ncard-body"></div>`;
    card.querySelector('.ntitle').textContent = n.title;
    const body = card.querySelector('.ncard-body');
    n.body.split('\n').forEach((line, i) => {
      if (i) body.appendChild(document.createTextNode('\n'));
      const sp = document.createElement('span');
      if (/^[A-Za-z][^:\n]{0,60}:\s*$/.test(line.trim())) sp.className = 'nh';
      sp.textContent = line;
      body.appendChild(sp);
    });
    card.querySelector('.ncard-head').addEventListener('click', e => {
      if (e.target.closest('button')) return;
      card.classList.toggle('open');
      card.classList.contains('open') ? openCards.add(n.id) : openCards.delete(n.id);
    });
    card.querySelector('.ncopy').addEventListener('click', () => { navigator.clipboard.writeText(`${n.title}\n\n${n.body}`); toast('Note copied', 'copy'); });
    card.querySelector('.ndel').addEventListener('click', () => send({ type: 'noteDel', id: n.id }));
    box.appendChild(card);
  });
}
function renderAllNoteCards() { panes.forEach(p => renderNoteCards(p)); }

// ---------- panes ----------
function buildPane(info) {
  const isNotes = info.kind === 'notes';
  const el = document.createElement('section');
  el.className = 'pane';
  el.style.setProperty('--kind', color(info.kind));
  el.style.setProperty('--kind-line', color(info.kind) + '59');
  el.innerHTML = `
    <header class="pane-head">
      <span class="dot"></span>
      <span class="pname">${esc(kindName(info.kind))}</span><span class="inst"></span>
      <span class="knobs" style="display:flex;gap:5px"></span>
      <span class="pstate"></span>
      <span class="grow"></span>
      <button class="bcast" title="Include this pane when you broadcast">${ICONS.radio}<span>Broadcast on</span></button>
      <button class="iconbtn more" title="Pane actions">${ICONS.more}</button>
    </header>
    ${isNotes
      ? `<div class="note-wrap">
           <div class="note-lb">Scratch pad, saves automatically</div>
           <textarea class="note-area" spellcheck="false" placeholder="Type anything here"></textarea>
           <div class="note-split" title="Drag to resize the scratch pad. Double-click to reset."></div>
           <div class="note-cards"></div>
         </div>`
      : '<div class="term"></div>'}
    <div class="gate-cover"><div class="gate-card"><b></b><p></p><div class="row"><button class="btn sm primary gate-focus">Answer in the pane</button><button class="btn sm ghost gate-hide">Hide</button></div></div></div>
    <div class="dead-cover">
      <span class="msg">This session has ended.</span>
      <button class="btn dead-rs">${ICONS.restart}Restart ${esc(kindName(info.kind))}</button>
    </div>`;
  panesEl.appendChild(el);

  const pane = { el, id: info.id, kind: info.kind, label: info.label, dead: false, broadcast: !isNotes, knobSels: [], busySince: 0 };
  const bcBtn = el.querySelector('.bcast');
  const setBroadcast = on => {
    pane.broadcast = on;
    bcBtn.classList.toggle('on', on);
    bcBtn.querySelector('span').textContent = on ? 'Broadcast on' : 'Broadcast off';
    renderTargets();
  };
  pane.setBroadcast = setBroadcast;
  el.querySelector('.more').addEventListener('click', e => { e.stopPropagation(); openPaneMenu(pane, e.currentTarget); });
  el.querySelector('.gate-hide').addEventListener('click', () => el.classList.remove('gated'));

  if (isNotes) {
    bcBtn.remove();
    const ta = el.querySelector('.note-area');
    ta.value = notesText;
    let saveTimer;
    ta.addEventListener('input', () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => send({ type: 'notesSet', text: ta.value }), 500); });
    ta.addEventListener('focus', () => { document.querySelectorAll('.pane').forEach(p => p.classList.remove('focused')); el.classList.add('focused'); });
    ta.addEventListener('blur', () => el.classList.remove('focused'));
    const SCRATCH_H = 'vibedeck-scratch-h';
    let savedH = 150;
    try { savedH = parseInt(localStorage.getItem(SCRATCH_H), 10) || 150; } catch {}
    ta.style.height = savedH + 'px';
    const split = el.querySelector('.note-split');
    split.addEventListener('dblclick', () => { ta.style.height = '150px'; try { localStorage.setItem(SCRATCH_H, '150'); } catch {} });
    split.addEventListener('mousedown', e => {
      e.preventDefault();
      split.classList.add('active');
      const startY = e.clientY, h0 = ta.offsetHeight, wrap = el.querySelector('.note-wrap');
      const move = ev => { ta.style.height = Math.max(40, Math.min(wrap.clientHeight - 90, h0 + ev.clientY - startY)) + 'px'; };
      const up = () => {
        split.classList.remove('active');
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        try { localStorage.setItem(SCRATCH_H, String(ta.offsetHeight)); } catch {}
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    Object.assign(pane, { term: null, fit: null, noteEl: ta, cardsEl: el.querySelector('.note-cards') });
    renderNoteCards(pane);
    panes.set(info.id, pane);
    relayout();
    return;
  }

  const term = new Terminal({
    theme: THEME, fontSize: 12.5, lineHeight: 1.2,
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    cursorBlink: true, scrollback: 8000, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.term'));
  // WebGL renderer: the DOM renderer smears full-screen TUI redraws
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch (e) { console.warn('webgl unavailable', e); }
  // fonts load after first paint; refit once they're in so cell sizes are right
  document.fonts?.ready.then(() => { try { fit.fit(); } catch {} });
  fit.fit();
  term.onData(d => send({ type: 'input', pane: info.id, data: d }));
  term.textarea.addEventListener('focus', () => { document.querySelectorAll('.pane').forEach(p => p.classList.remove('focused')); el.classList.add('focused'); });
  term.textarea.addEventListener('blur', () => el.classList.remove('focused'));
  Object.assign(pane, { term, fit });
  el.querySelector('.gate-focus').addEventListener('click', () => { el.classList.remove('gated'); term.focus(); });

  // knob dropdowns (model, effort): slash-typed for claude, relaunch flags for codex/grok.
  // All relaunch knobs combine into one flag string so changing effort keeps the model choice.
  const knobsEl = el.querySelector('.knobs');
  const relaunchKnobs = [];
  const relaunchArgs = () => relaunchKnobs.map(({ knob, sel }) => sel.value ? knob.argTemplate.replace('{v}', sel.value) : '').filter(Boolean).join(' ');
  for (const knob of KNOBS[info.kind] || []) {
    const sel = document.createElement('select');
    sel.className = 'chipsel';
    sel.title = knob.placeholder === 'model' ? 'Model' : 'Reasoning effort';
    const storeKey = `vibedeck-${info.kind}-${(knob.cmd || knob.argTemplate).replace(/[^a-z]/gi, '')}`;
    let saved = '';
    try { saved = localStorage.getItem(storeKey) || ''; } catch {}
    const choices = choicesFor(info.kind, knob);
    sel.innerHTML = `<option value="">${knob.placeholder}</option>` + choices.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (saved && choices.includes(saved)) sel.value = saved;
    if (knob.mode === 'relaunch') relaunchKnobs.push({ knob, sel });
    pane.knobSels.push({ knob, sel });
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (!v) return;
      if (knob.mode === 'relaunch') send({ type: 'restart', pane: info.id, args: relaunchArgs() });
      else slashCommand(info.id, knob.cmd, v);
      try { localStorage.setItem(storeKey, v); } catch {}
    });
    knobsEl.appendChild(sel);
  }

  // images: drop onto the pane or paste while it's focused. The server saves the
  // file and types its path into the CLI's input (the CLIs read image paths).
  const sendImage = file => {
    if (!file || !file.type.startsWith('image/')) return false;
    const rd = new FileReader();
    rd.onload = () => send({ type: 'image', pane: info.id, name: file.name || 'pasted.png', data: rd.result });
    rd.readAsDataURL(file);
    return true;
  };
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dropping'); });
  el.addEventListener('dragleave', () => el.classList.remove('dropping'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('dropping'); [...(e.dataTransfer?.files || [])].forEach(sendImage); });
  term.textarea.addEventListener('paste', e => {
    const img = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (img && sendImage(img.getAsFile())) { e.preventDefault(); e.stopImmediatePropagation(); }
  });

  if (info.kind === 'shell') setBroadcast(false);
  else setBroadcast(true);
  bcBtn.addEventListener('click', () => setBroadcast(!pane.broadcast));
  el.querySelector('.dead-rs').addEventListener('click', () => send({ type: 'restart', pane: info.id }));
  panes.set(info.id, pane);
  relayout();
}

function movePane(id, dir) {
  const order = [...panes.keys()];
  const i = order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  send({ type: 'reorder', order });
}

// one shared popover menu for every pane's "..." button
const paneMenu = $('paneMenu');
function closeMenus() { paneMenu.hidden = true; }
function openPaneMenu(pane, anchor) {
  const ai = ['claude', 'codex', 'grok'].includes(pane.kind);
  const others = [...panes.values()].filter(x => x !== pane && x.kind !== 'notes' && !x.dead);
  const order = [...panes.keys()], idx = order.indexOf(pane.id);
  const items = [];
  if (ai) {
    items.push(`<button class="menu-item" data-act="notes">${ICONS.note}Send answer to Notes</button>`);
    items.push(`<button class="menu-item" data-act="sidecar">${ICONS.sidecar}Send answer to Sidecar</button>`);
    if (others.length) {
      items.push('<div class="menu-label">Relay last answer to</div>');
      others.forEach(o => items.push(`<button class="menu-item" data-act="relay" data-to="${esc(o.id)}"><span class="dot" style="background:${color(o.kind)}"></span>${esc(paneTitle(o))}</button>`));
    }
    items.push('<div class="menu-sep"></div>');
  }
  items.push('<div class="menu-label">Switch this pane to</div>');
  roster.filter(r => r.id !== pane.kind).forEach(r => items.push(`<button class="menu-item" data-act="replace" data-kind="${esc(r.id)}"><span class="dot" style="background:${color(r.id)}"></span>${esc(kindName(r.id))}</button>`));
  items.push('<div class="menu-sep"></div>');
  items.push(`<button class="menu-item" data-act="left" ${idx === 0 ? 'disabled' : ''}>${ICONS.left}Move left</button>`);
  items.push(`<button class="menu-item" data-act="right" ${idx === order.length - 1 ? 'disabled' : ''}>${ICONS.right}Move right</button>`);
  if (pane.term) items.push(`<button class="menu-item" data-act="restart">${ICONS.restart}Restart</button>`);
  items.push(`<button class="menu-item danger" data-act="close" ${panes.size <= 1 ? 'disabled' : ''}>${ICONS.x}Close pane</button>`);
  paneMenu.innerHTML = items.join('');
  paneMenu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = paneMenu.offsetWidth, h = paneMenu.offsetHeight;
  paneMenu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  paneMenu.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  paneMenu.onclick = e => {
    const b = e.target.closest('.menu-item');
    if (!b || b.disabled) return;
    closeMenus();
    const act = b.dataset.act;
    if (act === 'notes') send({ type: 'toNotes', pane: pane.id });
    else if (act === 'sidecar') send({ type: 'toSidecar', pane: pane.id });
    else if (act === 'relay') send({ type: 'relay', pane: pane.id, to: b.dataset.to });
    else if (act === 'replace') send({ type: 'replace', pane: pane.id, kind: b.dataset.kind });
    else if (act === 'left') movePane(pane.id, -1);
    else if (act === 'right') movePane(pane.id, 1);
    else if (act === 'restart') send({ type: 'restart', pane: pane.id });
    else if (act === 'close') send({ type: 'close', pane: pane.id });
  };
}
document.addEventListener('mousedown', e => { if (!paneMenu.hidden && !paneMenu.contains(e.target)) closeMenus(); });
window.addEventListener('resize', closeMenus);

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
  for (const [id, p] of entries) { panes.set(id, p); panesEl.appendChild(p.el); }
  relayout();
}
function paneTitle(p) {
  const dupes = [...panes.values()].filter(x => x.kind === p.kind);
  return kindName(p.kind) + (dupes.length > 1 ? ` ${dupes.indexOf(p) + 1}` : '');
}

// ---- adjustable pane sizes: draggable splitters, fractions saved per layout ----
let frac = { cols: [], rows: [] };
const GUTTER = '10px';
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }
function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function applySplitTemplate() {
  panesEl.style.gridTemplateColumns = frac.cols.map(f => f + 'fr').join(` ${GUTTER} `);
  panesEl.style.gridTemplateRows = frac.rows.map(f => f + 'fr').join(` ${GUTTER} `);
}
function addSplitter(axis, idx, storeKey, gridColumn, gridRow) {
  const el = document.createElement('div');
  el.className = `split split-${axis}`;
  el.style.gridColumn = gridColumn;
  el.style.gridRow = gridRow;
  el.title = 'Drag to resize. Double-click to reset.';
  el.addEventListener('dblclick', () => {
    (axis === 'col' ? frac.cols : frac.rows).fill(1);
    applySplitTemplate(); store(storeKey, JSON.stringify(frac)); setTimeout(fitAll, 50);
  });
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    el.classList.add('active');
    const arr = axis === 'col' ? frac.cols : frac.rows;
    const start = axis === 'col' ? e.clientX : e.clientY;
    const a0 = arr[idx], b0 = arr[idx + 1];
    const totalPx = axis === 'col' ? panesEl.clientWidth : panesEl.clientHeight;
    const totalFr = arr.reduce((s, x) => s + x, 0);
    const move = ev => {
      const d = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / totalPx * totalFr;
      arr[idx] = Math.max(0.15, a0 + d);
      arr[idx + 1] = Math.max(0.15, b0 - d);
      applySplitTemplate();
      clearTimeout(fitTimer); fitTimer = setTimeout(fitAll, 80);
    };
    const up = () => {
      el.classList.remove('active');
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      store(storeKey, JSON.stringify(frac)); fitAll();
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  panesEl.appendChild(el);
}
function relayout() {
  const n = panes.size;
  const all = [...panes.values()];
  panesEl.querySelectorAll('.split').forEach(s => s.remove());
  const storeKey = `vibedeck-split-${n}`;
  let saved = null;
  try { saved = JSON.parse(load(storeKey)); } catch {}
  if (n <= 3) {
    frac = (saved && saved.cols?.length === n) ? saved : { cols: Array(n).fill(1), rows: [1] };
    frac.rows = [1];
    applySplitTemplate();
    all.forEach((p, i) => { p.el.style.gridColumn = String(1 + i * 2); p.el.style.gridRow = '1'; });
    for (let i = 0; i < n - 1; i++) addSplitter('col', i, storeKey, String(2 + i * 2), '1');
  } else if (n === 4) {
    frac = (saved && saved.cols?.length === 2 && saved.rows?.length === 2) ? saved : { cols: [1, 1], rows: [1, 1] };
    applySplitTemplate();
    const pos = [[1, 1], [3, 1], [1, 3], [3, 3]];
    all.forEach((p, i) => { p.el.style.gridColumn = String(pos[i][0]); p.el.style.gridRow = String(pos[i][1]); });
    addSplitter('col', 0, storeKey, '2', '1 / -1');
    addSplitter('row', 0, storeKey, '1 / -1', '2');
  } else {
    // 5 panes: 3 up top, 2 below. Bottom-left spans two tracks so the last pane gets the right column.
    frac = (saved && saved.cols?.length === 3 && saved.rows?.length === 2) ? saved : { cols: [1, 1, 1], rows: [1, 1] };
    applySplitTemplate();
    const pos = [['1', '1'], ['3', '1'], ['5', '1'], ['1 / 4', '3'], ['5', '3']];
    all.forEach((p, i) => { p.el.style.gridColumn = pos[i][0]; p.el.style.gridRow = pos[i][1]; });
    addSplitter('col', 0, storeKey, '2', '1');
    addSplitter('col', 1, storeKey, '4', '1 / -1');
    addSplitter('row', 0, storeKey, '1 / -1', '2');
  }
  const counts = {}, seen = {};
  all.forEach(p => { counts[p.kind] = (counts[p.kind] || 0) + 1; });
  all.forEach(p => { seen[p.kind] = (seen[p.kind] || 0) + 1; p.el.querySelector('.inst').textContent = counts[p.kind] > 1 ? String(seen[p.kind]) : ''; });
  document.querySelectorAll('#paneSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === n));
  renderTargets();
  setTimeout(fitAll, 50);
}

// pane count: grow by adding CLIs (unused kinds first, then more claudes), shrink from the right
$('paneSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (needsFolder) return toast('Choose a project folder first.', 'folder');
  const want = Number(b.dataset.n), cur = panes.size;
  if (want > cur) {
    const active = new Set([...panes.values()].map(p => p.kind));
    const fresh = roster.filter(r => !['shell', 'notes'].includes(r.id) && !active.has(r.id)).map(r => r.id);
    for (let i = 0; i < want - cur; i++) send({ type: 'add', kind: fresh.shift() || 'claude' });
  } else if (want < cur) {
    [...panes.values()].slice(want).forEach(p => send({ type: 'close', pane: p.id }));
  }
  promptEl.focus();
});

// "Sends to" line under the prompt
function renderTargets() {
  const el = $('targets');
  const on = [...panes.values()].filter(p => p.broadcast && p.term && !p.dead);
  el.classList.toggle('none', !on.length && panes.size > 0);
  el.innerHTML = !panes.size ? '' : on.length
    ? 'Sends to' + on.map(p => `<i style="background:${color(p.kind)}"></i>${esc(paneTitle(p))}`).join('')
    : 'No pane has broadcast on';
}

// pane status text: Idle, a live timer while answering, or Exited
setInterval(() => panes.forEach(p => {
  const st = p.el.querySelector('.pstate');
  if (!st) return;
  if (p.dead) { st.textContent = 'Exited'; st.classList.remove('live'); }
  else if (p.busySince) { st.textContent = fmtClock(Date.now() - p.busySince); st.classList.add('live'); }
  else { st.textContent = p.term ? 'Idle' : ''; st.classList.remove('live'); }
}), 1000);

function setRoundActive(on) {
  roundActive = on;
  $('stopRoundBtn').hidden = !on;
}

// ---------- websocket ----------
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'init') {
    roster = msg.roster; maxPanes = msg.maxPanes;
    history = msg.history || []; playbooks = msg.playbooks || [];
    modelsCfg = msg.models || {};
    notesText = msg.notes || ''; noteItems = msg.noteItems || []; rounds = msg.rounds || [];
    desktop = !!msg.desktop; home = msg.home || '';
    renderAllNoteCards();
    setJudges(msg.judges || []);
    setCwd(msg.cwd || '', msg.recents || [], msg.needsFolder);
    setPlaybooks();
    if (!panes.size) msg.panes.forEach(p => buildPane(p));
    setTimeout(nudgeAll, 600); // repaint after scrollback replay
  } else if (msg.type === 'data') {
    panes.get(msg.pane)?.term?.write(msg.data);
  } else if (msg.type === 'exit') {
    const p = panes.get(msg.pane);
    if (p) { p.dead = true; p.busySince = 0; p.el.classList.add('dead'); p.el.classList.remove('gated'); renderTargets(); }
  } else if (msg.type === 'restarted') {
    const p = panes.get(msg.pane);
    if (p && p.term) {
      p.dead = false; p.busySince = 0;
      p.el.classList.remove('dead');
      p.term.reset();
      send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows });
      renderTargets();
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
  } else if (msg.type === 'paneWaiting') {
    const p = panes.get(msg.pane);
    if (!p) return;
    p.el.classList.toggle('gated', !!msg.reason);
    if (msg.reason) {
      p.el.querySelector('.gate-card b').textContent = msg.title || `${kindName(p.kind)} needs an answer`;
      p.el.querySelector('.gate-card p').textContent = msg.reason;
    }
  } else if (msg.type === 'imageSaved') {
    const p = panes.get(msg.pane);
    toast(`${msg.file} sent to ${p ? paneTitle(p) : 'the pane'}. Its path was typed into the prompt.`, 'image');
  } else if (msg.type === 'relayed') {
    const from = panes.get(msg.from), to = panes.get(msg.to);
    toast(`Relayed ${from ? paneTitle(from) : 'the answer'} to ${to ? paneTitle(to) : 'the other pane'}`, 'send');
  } else if (msg.type === 'roundStarted') {
    // dots pulse while a pane is still answering; a fresh round supersedes the old one
    panes.forEach(p => { p.busySince = 0; p.el.querySelector('.dot')?.classList.remove('busy'); });
    (msg.targets || []).forEach(id => { const p = panes.get(id); if (p) { p.busySince = Date.now(); p.el.querySelector('.dot')?.classList.add('busy'); } });
    setRoundActive(true);
  } else if (msg.type === 'answerDone' || msg.type === 'answerFailed') {
    const p = panes.get(msg.pane);
    if (p) { p.busySince = 0; p.el.querySelector('.dot')?.classList.remove('busy'); }
    if (msg.type === 'answerFailed') toast(`${p ? paneTitle(p) : 'A pane'}: ${msg.text}`, 'warn', true);
  } else if (msg.type === 'roundDone' || msg.type === 'roundFailed' || msg.type === 'roundStopped') {
    panes.forEach(p => { p.busySince = 0; p.el.querySelector('.dot')?.classList.remove('busy'); });
    setRoundActive(false);
    if (msg.type === 'roundStopped') return toast('Stopped waiting for this round. The panes keep whatever they already wrote.');
    $('cmpBtn').classList.add('glow');
    toast(msg.type === 'roundFailed' ? 'Some panes did not finish. Compare shows what came back.' : msg.count > 1 ? 'All answers are in. Open Compare to see them side by side.' : 'The answer is in.', 'check');
  } else if (msg.type === 'hist') {
    history.push(msg.item);
  } else if (msg.type === 'round') {
    renderCompare(msg);
  } else if (msg.type === 'roundSaved') {
    rounds.push(msg.round);
  } else if (msg.type === 'crowned') {
    const r = rounds.find(x => x.ts === msg.ts);
    if (r) r.winnerKind = msg.kind;
  } else if (msg.type === 'judging') {
    const v = $('verdict');
    v.classList.add('open');
    v.innerHTML = `<div class="v-head">${ICONS.scale}Judging with ${esc(kindName(msg.kind))}</div>Reading every answer. This can take a minute.`;
  } else if (msg.type === 'judgement') {
    const v = $('verdict');
    v.classList.add('open');
    v.innerHTML = `<div class="v-head">${ICONS.scale}Verdict from ${esc(kindName(msg.kind))}</div>`;
    v.appendChild(Object.assign(document.createElement('span'), { textContent: msg.text }));
  } else if (msg.type === 'playbooks') {
    playbooks = msg.items || []; setPlaybooks();
  } else if (msg.type === 'modelsUpdating') {
    toast('Refreshing model lists. The model menus in the panes will flash.', 'restart');
  } else if (msg.type === 'models') {
    modelsCfg = msg.config || {};
    repopulateKnobs();
    toast(`Models: ${msg.report}`);
    if (applyLatestPending) { applyLatestPending = false; applyLatestModels(); }
  } else if (msg.type === 'notes') {
    notesText = msg.text || '';
    panes.forEach(p => { if (p.noteEl && document.activeElement !== p.noteEl) p.noteEl.value = notesText; });
  } else if (msg.type === 'notesWorking') {
    toast('Writing that answer up as a plain-English note. About 15 seconds.', 'note');
  } else if (msg.type === 'noteItems') {
    noteItems = msg.items || []; renderAllNoteCards();
  } else if (msg.type === 'notesAppended') {
    const from = panes.get(msg.from);
    toast(msg.ok ? `Note from ${from ? paneTitle(from) : 'the pane'} added. Click it to expand.` : 'Could not rewrite it, so the raw answer was saved as a note.', 'note');
    panes.forEach(p => { if (p.cardsEl) p.cardsEl.scrollTop = 0; });
  } else if (msg.type === 'notesError' || msg.type === 'notice') {
    toast(msg.text, 'info');
  } else if (msg.type === 'cwdChanged') {
    setCwd(msg.cwd, msg.recents || recents, msg.needsFolder);
    $('cwdPanel').hidden = true;
    $('cwdBtn').classList.remove('open');
    toast(`Working in ${msg.cwd}`, 'folder');
  } else if (msg.type === 'cwdError') {
    toast(msg.text || 'That folder does not exist.', 'folder', true);
  } else if (msg.type === 'folderPicked') {
    if (msg.dir) send({ type: 'setcwd', dir: msg.dir });
  }
});
ws.addEventListener('close', () => {
  $('reconnect').classList.add('open');
  const retry = setInterval(async () => {
    try { const r = await fetch('/', { cache: 'no-store' }); if (r.ok) { clearInterval(retry); location.reload(); } } catch {}
  }, 2000);
});

// ---------- project folder ----------
function setCwd(dir, rec, gate) {
  cwd = dir; recents = rec || [];
  needsFolder = !!gate;
  const parts = dir.split(/[\\/]/).filter(Boolean);
  $('cwdName').textContent = needsFolder ? 'No project folder' : (parts[parts.length - 1] || dir || 'Folder');
  $('cwdPath').textContent = needsFolder ? 'Choose one to start' : dir;
  $('cwdBtn').classList.toggle('warn', needsFolder);
  $('cwdBtn').title = needsFolder ? 'Choose a project folder' : `Project folder: ${dir}`;
  $('cwdCur').textContent = needsFolder ? 'None chosen yet' : dir;
  const list = recents.filter(r => r !== dir && r.toLowerCase() !== home.toLowerCase()).slice(0, 7);
  for (const box of [$('cwdRecents'), $('gateRecents')]) {
    box.innerHTML = '';
    list.forEach(r => {
      const b = document.createElement('button');
      b.className = 'recent';
      b.innerHTML = ICONS.folder + '<span></span>';
      b.querySelector('span').textContent = r;
      b.addEventListener('click', () => send({ type: 'setcwd', dir: r }));
      box.appendChild(b);
    });
    if (!list.length && box === $('cwdRecents')) box.innerHTML = '<div class="more" style="padding:6px 2px">No other folders yet</div>';
  }
  $('cwdBrowse').hidden = !desktop;
  $('gateBrowse').hidden = !desktop;
  window.dispatchEvent(new CustomEvent('vd:cwd', { detail: { cwd, needsFolder } }));
}
function toggleCwdPanel(open) {
  const panel = $('cwdPanel');
  panel.hidden = !open;
  $('cwdBtn').classList.toggle('open', open);
  if (!open) return;
  const r = $('cwdBtn').getBoundingClientRect();
  panel.style.left = r.left + 'px';
  panel.style.top = (r.bottom + 6) + 'px';
  $('cwdInput').value = '';
  $('cwdInput').focus();
}
$('cwdBtn').addEventListener('click', e => { e.stopPropagation(); toggleCwdPanel($('cwdPanel').hidden); });
document.addEventListener('mousedown', e => { if (!$('cwdPanel').hidden && !$('cwdPanel').contains(e.target) && !$('cwdBtn').contains(e.target)) toggleCwdPanel(false); });
const goCwd = input => { const d = input.value.trim(); if (d) send({ type: 'setcwd', dir: d }); };
$('cwdGo').addEventListener('click', () => goCwd($('cwdInput')));
$('cwdInput').addEventListener('keydown', e => { if (e.key === 'Enter') goCwd($('cwdInput')); });
$('gateGo').addEventListener('click', () => goCwd($('gateInput')));
$('gateInput').addEventListener('keydown', e => { if (e.key === 'Enter') goCwd($('gateInput')); });
const browse = () => { toggleCwdPanel(false); send({ type: 'pickFolder' }); };
$('cwdBrowse').addEventListener('click', browse);
$('gateBrowse').addEventListener('click', browse);

// ---------- playbooks ----------
const playbookEl = $('playbook');
function setPlaybooks() {
  playbookEl.innerHTML = '<option value="">Playbook</option>' + playbooks.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
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

// ---------- meter sidebar ----------
const meterBar = $('meterbar'), meterFrame = $('meterframe');
function setMeter(open) {
  if (open && !meterFrame.src) meterFrame.src = '/meter'; // lazy-load: no polling while closed
  meterBar.classList.toggle('open', open);
  $('meterBtn').classList.toggle('on', open);
  store('vibedeck-meterbar', open ? '1' : '0');
  setTimeout(fitAll, 220);
}
$('meterBtn').addEventListener('click', () => setMeter(!meterBar.classList.contains('open')));
if (load('vibedeck-meterbar') === '1') setMeter(true);

// ---------- models refresh ----------
function repopulateKnobs() {
  panes.forEach(p => (p.knobSels || []).forEach(({ knob, sel }) => {
    const cur = sel.value;
    const choices = choicesFor(p.kind, knob);
    sel.innerHTML = `<option value="">${knob.placeholder}</option>` + choices.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (choices.includes(cur)) sel.value = cur;
  }));
}
// refresh the lists from the CLIs, then jump every pane to the newest model in its list
let applyLatestPending = false;
$('modelsBtn').addEventListener('click', () => { applyLatestPending = true; send({ type: 'updateModels' }); });
function applyLatestModels() {
  const moved = [];
  panes.forEach(p => (p.knobSels || []).forEach(({ knob, sel }) => {
    if (knob.list !== 'models') return;
    const choices = choicesFor(p.kind, knob);
    if (!choices.length || sel.value === choices[0]) return;
    sel.value = choices[0];
    sel.dispatchEvent(new Event('change'));
    moved.push(`${paneTitle(p)} to ${choices[0]}`);
  }));
  toast(moved.length ? `Switched ${moved.join(', ')}` : 'Every pane is already on the newest model.', 'restart');
}

// ---------- shortcuts help ----------
$('helpBtn').addEventListener('click', () => $('helpOverlay').classList.add('open'));
$('helpClose').addEventListener('click', () => $('helpOverlay').classList.remove('open'));

// ---------- compare + judge ----------
const WINS_KEY = 'vibedeck-wins';
const getWins = () => { try { return JSON.parse(load(WINS_KEY)) || {}; } catch { return {}; } };
$('cmpBtn').addEventListener('click', () => { $('cmpBtn').classList.remove('glow'); send({ type: 'round' }); });
$('cmpClose').addEventListener('click', () => $('cmpOverlay').classList.remove('open'));
const JUDGE_KEY = 'vibedeck-judge';
const judgeKindEl = $('judgeKind');
function setJudges(list) {
  judgeKindEl.innerHTML = list.map(k => `<option value="${esc(k)}">Judge: ${esc(kindName(k))}</option>`).join('');
  judgeKindEl.style.display = list.length ? '' : 'none';
  const saved = load(JUDGE_KEY);
  if (saved && list.includes(saved)) judgeKindEl.value = saved;
}
judgeKindEl.addEventListener('change', () => store(JUDGE_KEY, judgeKindEl.value));
$('judgeBtn').addEventListener('click', () => send({ type: 'judge', kind: judgeKindEl.value }));

function renderCompare(round) {
  const cols = $('cmpCols');
  cols.innerHTML = '';
  $('verdict').classList.remove('open');
  $('cmpPrompt').textContent = round.prompt || 'Nothing yet. Broadcast a prompt, let the models answer, then open Compare.';
  const wins = getWins();
  const rs = (round.responses || []).filter(r => r.text);
  cols.style.gridTemplateColumns = `repeat(${Math.max(rs.length, 1)}, minmax(0, 1fr))`;
  if (!rs.length) cols.innerHTML = '<div class="cmp-col"><div class="cmp-body">No answers captured yet. Broadcast something, give the models a minute, then come back.</div></div>';
  rs.forEach(r => {
    const col = document.createElement('div');
    col.className = 'cmp-col';
    col.style.setProperty('--kind', color(r.kind));
    col.innerHTML = `
      <div class="col-head">
        <span class="nm">${esc(kindName(r.kind))}</span><span class="wins">${wins[r.kind] ? wins[r.kind] + ' wins' : ''}</span>
        <span class="grow"></span>
        <button class="btn sm ghost copy">${ICONS.copy}<span>Copy</span></button>
        <button class="btn sm ghost promote" title="Carry this answer into the prompt and keep going from it">${ICONS.promote}Continue from this</button>
        <button class="btn sm ghost win">${ICONS.award}Winner</button>
      </div>
      <div class="cmp-body"></div>`;
    col.querySelector('.cmp-body').textContent = r.text;
    if (round.winnerKind === r.kind) col.classList.add('winner');
    col.querySelector('.copy').addEventListener('click', e => {
      navigator.clipboard.writeText(r.text);
      const s = e.currentTarget.querySelector('span');
      s.textContent = 'Copied'; setTimeout(() => s.textContent = 'Copy', 1500);
    });
    col.querySelector('.promote').addEventListener('click', () => {
      promptEl.value = `${PROMOTE_HEAD} Original prompt:\n${round.prompt}\n\nWinner (${kindName(r.kind)}):\n${r.text}\n\nNext: `;
      sizePrompt();
      $('cmpOverlay').classList.remove('open');
      window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' }));
      promptEl.focus();
      promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
    });
    col.querySelector('.win').addEventListener('click', () => {
      const w = getWins();
      w[r.kind] = (w[r.kind] || 0) + 1;
      store(WINS_KEY, JSON.stringify(w));
      cols.querySelectorAll('.cmp-col').forEach(c => c.classList.remove('winner'));
      col.classList.add('winner');
      col.querySelector('.wins').textContent = `${w[r.kind]} wins`;
      if (round.ts) send({ type: 'crown', ts: round.ts, kind: r.kind });
    });
    cols.appendChild(col);
  });
  $('cmpOverlay').classList.add('open');
}

// ---------- prompt (Enter sends, Shift+Enter = new line) ----------
function sizePrompt() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(Math.max(promptEl.scrollHeight, 44), 180) + 'px';
}
function broadcastPrompt() {
  const text = promptEl.value;
  if (!text.trim()) return promptEl.focus();
  if (needsFolder) return toast('Choose a project folder first.', 'folder');
  if (roundActive) return toast('Answers from the last round are still coming in. Wait, or press Stop round.', 'info');
  const targets = [...panes.values()].filter(p => p.broadcast && p.term && !p.dead).map(p => p.id);
  if (!targets.length) return toast('Turn on Broadcast for at least one pane first.', 'radio');
  const out = { type: 'broadcast', data: text, targets };
  if (text.startsWith(PROMOTE_HEAD)) out.noHist = true;
  send(out);
  histIdx = -1;
  promptEl.value = '';
  sizePrompt();
}
promptEl.addEventListener('input', sizePrompt);
promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    broadcastPrompt();
  } else if (e.key === 'ArrowUp' && !promptEl.value.slice(0, promptEl.selectionStart).includes('\n')) {
    e.preventDefault();
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
$('broadcastBtn').addEventListener('click', broadcastPrompt);
$('stopRoundBtn').addEventListener('click', () => send({ type: 'stopRound' }));

// ---------- terminal plumbing ----------
function fitAll() {
  panes.forEach(p => {
    if (!p.term || !p.el.offsetParent) return;
    try { p.fit.fit(); send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows }); } catch {}
  });
}
// shrink-then-restore forces full-screen TUIs to repaint cleanly
function nudgeOne(p) {
  if (!p || !p.term) return;
  send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows - 1 });
  setTimeout(() => { send({ type: 'resize', pane: p.id, cols: p.term.cols, rows: p.term.rows }); p.term.scrollToBottom(); }, 120);
}
function nudgeAll() { fitAll(); panes.forEach(nudgeOne); }
let fitTimer;
new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitAll, 100); }).observe(panesEl);

// global shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!paneMenu.hidden) return closeMenus();
    for (const id of ['cmpOverlay', 'helpOverlay']) if ($(id).classList.contains('open')) { $(id).classList.remove('open'); return; }
    if (!$('cwdPanel').hidden) return toggleCwdPanel(false);
  }
  if (e.ctrlKey && ['1', '2', '3', '4', '5'].includes(e.key)) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' }));
    const pane = [...panes.values()][Number(e.key) - 1];
    (pane?.term || pane?.noteEl)?.focus();
  } else if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' }));
    promptEl.focus();
  }
});
sizePrompt();
