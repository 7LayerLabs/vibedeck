// App shell: page switching, sidebar provider status, and the "choose a folder" gate.
(() => {
  const VIEWS = { workbench: 'Workbench', pipelines: 'Pipelines', history: 'History', connections: 'Connections' };
  let current = 'workbench';
  let health = [];

  function setView(name) {
    if (!VIEWS[name]) name = 'workbench';
    current = name;
    for (const v of Object.keys(VIEWS)) $('view-' + v).hidden = v !== name;
    document.querySelectorAll('.nav[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $('crumbTitle').textContent = VIEWS[name];
    $('wbTools').hidden = name !== 'workbench' || needsFolder;
    store('vibedeck-view', name);
    closeMenus();
    window.dispatchEvent(new CustomEvent('vd:shown', { detail: name }));
    if (name === 'workbench') setTimeout(fitAll, 30);
  }
  document.querySelectorAll('.nav[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  window.addEventListener('vd:view', e => setView(e.detail));

  window.addEventListener('vd:cwd', e => {
    const gate = e.detail.needsFolder;
    $('folderGate').hidden = !gate;
    $('deck').hidden = gate;
    $('composer').hidden = gate;
    $('wbTools').hidden = current !== 'workbench' || gate;
    $('crumbPath').textContent = gate ? 'No project folder' : e.detail.cwd;
    if (!gate) setTimeout(fitAll, 30);
  });

  const INSTALL = { claude: 'npm i -g @anthropic-ai/claude-code', codex: 'npm i -g @openai/codex', grok: 'Install the Grok CLI from x.ai' };
  function renderProviders() {
    $('provList').innerHTML = health.map(h => `
      <button class="prov" data-kind="${esc(h.id)}" title="${h.ok ? esc(kindName(h.id) + ' CLI ' + (h.version || 'installed')) : esc(INSTALL[h.id] || 'Not installed')}">
        <span class="pdot ${h.ok ? '' : 'off'}"></span>${esc(kindName(h.id))}
        <span class="s">${h.ok ? (h.version ? 'v' + esc(h.version) : 'Ready') : 'Missing'}</span>
      </button>`).join('');
  }
  $('provList').addEventListener('click', e => { if (e.target.closest('.prov')) setView('connections'); });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      health = msg.health || [];
      renderProviders();
      $('appVersion').textContent = msg.version ? 'v' + msg.version : '';
      window.vdHealth = health;
      let saved = load('vibedeck-view');
      setView(saved && VIEWS[saved] ? saved : 'workbench');
    } else if (msg.type === 'health') {
      health = msg.health || [];
      window.vdHealth = health;
      renderProviders();
      window.dispatchEvent(new CustomEvent('vd:health', { detail: health }));
    }
  });
})();
