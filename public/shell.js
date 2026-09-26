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
  // ---------- usage meters: each CLI's own report of how much of its plan is used ----------
  let usage = {};
  const money = n => n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
  const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
  const bar = (pct, cls, title) => `<div class="meter ${cls}" title="${esc(title)}"><div class="meter-fill" style="width:${Math.max(2, Math.min(100, pct))}%"></div></div>`;
  const level = pct => pct >= 85 ? 'hot' : pct >= 60 ? 'warm' : '';
  // compact = sidebar (the tightest limit only); full = Connections page (every window)
  function usageHtml(kind, full) {
    const u = usage[kind];
    if (kind === 'grok') {
      if (!u) return full ? '<div class="meter-txt">No Grok usage recorded this week yet.</div>' : '';
      const rel = u.busiestCost > 0 ? (u.today.cost / u.busiestCost) * 100 : 0;
      const title = `Grok reports no plan limit, so this bar compares today with your busiest day this week (${money(u.busiestCost)}).`;
      return `${bar(rel, '', title)}<div class="meter-txt" title="${esc(title)}">${tokens(u.today.tokens)} tokens, ${money(u.today.cost)} today</div>`;
    }
    if (!u || !u.windows?.length) return full ? `<div class="meter-txt">Usage appears after ${kindName(kind)} is used once.</div>` : '';
    const wins = full ? u.windows : [u.windows.reduce((a, b) => (b.pct > a.pct ? b : a))];
    const where = kind === 'claude' ? "Claude's /usage" : "Codex's own logs";
    return wins.map(w => {
      const title = `${w.pct}% of your ${w.label} limit used${w.resets ? `, resets ${w.resets}` : ''}. From ${where}.`;
      return `${bar(w.pct, level(w.pct), title)}<div class="meter-txt" title="${esc(title)}">${w.pct}% of ${esc(w.label)} limit${full && w.resets ? `, resets ${esc(w.resets)}` : ''}</div>`;
    }).join('');
  }
  window.vdUsageHtml = usageHtml;

  function renderProviders() {
    $('provList').innerHTML = health.map(h => `
      <button class="prov" data-kind="${esc(h.id)}" title="${h.ok ? esc(kindName(h.id) + ' CLI ' + (h.version || 'installed')) : esc(INSTALL[h.id] || 'Not installed')}">
        <span class="prov-top"><span class="pdot ${h.ok ? '' : 'off'}"></span>${esc(kindName(h.id))}
        <span class="s">${h.ok ? (h.version ? 'v' + esc(h.version) : 'Ready') : 'Missing'}</span></span>
        ${h.ok ? `<span class="prov-meter" style="--kind:${color(h.id)}">${usageHtml(h.id, false)}</span>` : ''}
      </button>`).join('');
  }
  $('provList').addEventListener('click', e => { if (e.target.closest('.prov')) setView('connections'); });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      health = msg.health || [];
      usage = msg.usage || {};
      renderProviders();
      $('appVersion').textContent = msg.version ? 'v' + msg.version : '';
      window.vdHealth = health;
      let saved = load('vibedeck-view');
      setView(saved && VIEWS[saved] ? saved : 'workbench');
    } else if (msg.type === 'usage') {
      usage = msg.usage || {};
      renderProviders();
      window.dispatchEvent(new CustomEvent('vd:usage'));
    } else if (msg.type === 'health') {
      health = msg.health || [];
      window.vdHealth = health;
      renderProviders();
      window.dispatchEvent(new CustomEvent('vd:health', { detail: health }));
    }
  });
})();
