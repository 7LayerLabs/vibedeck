// Connections page: provider CLIs (sign-in + status) and API / local model connections.
(() => {
  const root = $('view-connections');
  let items = [], secureKeys = false, results = {}, health = [];
  const PRESETS = {
    xai: ['Grok API', 'https://api.x.ai/v1', 'openai'],
    openai: ['OpenAI API', 'https://api.openai.com/v1', 'openai'],
    anthropic: ['Claude API', 'https://api.anthropic.com/v1', 'anthropic'],
    ollama: ['Ollama', 'http://127.0.0.1:11434/v1', 'openai'],
    lmstudio: ['LM Studio', 'http://127.0.0.1:1234/v1', 'openai'],
    custom: ['Custom model', '', 'openai'],
  };
  const BLURB = {
    claude: 'Anthropic\'s coding CLI. Uses your Claude subscription or API account.',
    codex: 'OpenAI\'s coding CLI. Uses your ChatGPT plan or API account.',
    grok: 'xAI\'s coding CLI. Uses your Grok account.',
  };
  const INSTALL = { claude: 'npm i -g @anthropic-ai/claude-code', codex: 'npm i -g @openai/codex', grok: 'See x.ai for the Grok CLI installer' };

  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Connections</div><h2>Your AI providers</h2>
      <p>VibeDeck drives the coding CLIs you already have, using your own accounts. You can also add API keys or local models for pipeline stages.</p></div></div>
    <div class="prov-grid" id="cProv"></div>
    <div class="section-h"><h3>API and local models</h3><p>Use these as pipeline stages. They answer in text and never touch your files.</p></div>
    <div class="card conn-list" id="cList"></div>
    <div class="section-h"><h3 id="cFormTitle">Add a connection</h3></div>
    <form class="card conn-form" id="cForm" autocomplete="off">
      <input type="hidden" id="cId">
      <label class="field"><span>Provider</span><select class="select" id="cPreset">
        <option value="xai">Grok (xAI)</option><option value="openai">OpenAI</option><option value="anthropic">Claude (Anthropic)</option>
        <option value="ollama">Ollama, on this computer</option><option value="lmstudio">LM Studio, on this computer</option><option value="custom">Other compatible endpoint</option></select></label>
      <label class="field"><span>Name</span><input class="input" id="cName" required maxlength="80"></label>
      <label class="field"><span>Model ID</span><input class="input mono" id="cModel" required maxlength="150" placeholder="The exact model name, like grok-4.5" spellcheck="false"></label>
      <label class="field"><span>API key <em id="cKeyHint"></em></span><input class="input mono" id="cKey" type="password" maxlength="4096" placeholder="Paste your key" spellcheck="false"></label>
      <label class="field"><span>Base URL</span><input class="input mono" id="cUrl" required type="url" spellcheck="false"></label>
      <label class="field"><span>API format</span><select class="select" id="cProto"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></select></label>
      <div class="actions">
        <label class="switch" id="cRememberWrap"><input type="checkbox" id="cRemember">Remember the key on this computer</label>
        <span class="grow"></span>
        <span class="form-status" id="cStatus" role="status"></span>
        <button type="button" class="btn ghost" id="cNew">Clear</button>
        <button type="submit" class="btn primary">${ICONS.save}Save connection</button>
      </div>
    </form>
    <details class="more"><summary>About keys, billing and privacy</summary>
      <p>Signing in to a CLI uses that provider's own login. VibeDeck never turns a subscription into an API key. API usage is billed by the provider. Remembered keys are encrypted by your operating system and never shown again. Without "remember", a key lasts until VibeDeck closes. Hosted endpoints must use HTTPS. Local servers on this computer can use plain HTTP and usually need no key.</p>
    </details>`;

  function renderProviders() {
    $('cProv').innerHTML = ['claude', 'codex', 'grok'].map(k => {
      const h = health.find(x => x.id === k) || {};
      return `<div class="card prov-card" style="--kind:${color(k)}">
        <div class="top"><span class="pdot ${h.ok ? '' : 'off'}"></span><span class="nm">${kindName(k)}</span><span class="ver">${h.ok ? (h.version ? 'v' + esc(h.version) : 'Installed') : 'Not installed'}</span></div>
        <p>${esc(BLURB[k])}</p>
        ${h.ok
          ? `<div class="row"><button class="btn sm" data-signin="${k}">${ICONS.key}Sign in</button><button class="btn sm ghost" data-open="${k}">${ICONS.terminal}Open a terminal</button></div>`
          : `<p>Install it, then restart VibeDeck:</p><code>${esc(INSTALL[k])}</code>`}
      </div>`;
    }).join('');
  }
  function renderList() {
    $('cList').innerHTML = items.length ? items.map(c => {
      const r = results[c.id];
      return `<div class="conn" data-id="${esc(c.id)}">
        <div class="info"><b>${esc(c.name)}</b><small>${esc(c.model)} at ${esc(c.baseUrl)}, ${c.hasKey ? 'key saved' : c.local ? 'local, no key needed' : 'key needed'}</small></div>
        <button class="btn sm" data-act="test" ${r?.busy ? 'disabled' : ''}>${r?.busy ? 'Testing' : 'Test'}</button>
        <button class="btn sm" data-act="use">Use in a pipeline</button>
        <button class="btn sm ghost" data-act="edit">${ICONS.edit}Edit</button>
        <button class="iconbtn" data-act="remove" title="Remove">${ICONS.trash}</button>
        ${r && !r.busy ? `<div class="res ${r.ok ? 'ok' : 'bad'}">${esc(r.text)}</div>` : ''}
      </div>`;
    }).join('') : '<div class="empty">No API or local models yet. Add one below.</div>';
    $('cRemember').disabled = !secureKeys;
    $('cRememberWrap').title = secureKeys ? 'Encrypted with your operating system' : 'Only available in the desktop app';
  }
  function applyPreset(key) {
    const p = PRESETS[key];
    $('cName').value = p[0]; $('cUrl').value = p[1]; $('cProto').value = p[2];
    $('cKey').value = ''; $('cModel').value = '';
    const local = key === 'ollama' || key === 'lmstudio';
    $('cKeyHint').textContent = local ? 'not needed for local servers' : '';
  }
  function resetForm() {
    $('cId').value = ''; $('cPreset').value = 'xai'; applyPreset('xai');
    $('cRemember').checked = false; $('cFormTitle').textContent = 'Add a connection';
    $('cKey').placeholder = 'Paste your key'; $('cStatus').textContent = '';
  }
  $('cPreset').addEventListener('change', () => applyPreset($('cPreset').value));
  $('cNew').addEventListener('click', resetForm);
  $('cForm').addEventListener('submit', e => {
    e.preventDefault();
    $('cStatus').classList.remove('bad');
    $('cStatus').textContent = 'Saving';
    send({ type: 'connectionSave', connection: { id: $('cId').value, name: $('cName').value, baseUrl: $('cUrl').value, protocol: $('cProto').value, model: $('cModel').value, apiKey: $('cKey').value, remember: $('cRemember').checked && secureKeys } });
    $('cKey').value = '';
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.signin) send({ type: 'cliSignIn', kind: b.dataset.signin });
    if (b.dataset.open) {
      if (needsFolder) return toast('Choose a project folder first.', 'folder');
      send({ type: 'add', kind: b.dataset.open });
      window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' }));
    }
    const row = b.closest('.conn');
    if (!row) return;
    const c = items.find(x => x.id === row.dataset.id);
    if (!c) return;
    const act = b.dataset.act;
    if (act === 'test') { results[c.id] = { busy: true }; renderList(); send({ type: 'connectionTest', id: c.id }); }
    if (act === 'remove') send({ type: 'connectionRemove', id: c.id });
    if (act === 'use') window.dispatchEvent(new CustomEvent('vd:usePipeline', { detail: { name: `${c.name} answer`, steps: [{ role: 'Plan', kind: 'api', connectionId: c.id, model: '', instructions: '' }] } }));
    if (act === 'edit') {
      $('cId').value = c.id; $('cPreset').value = 'custom';
      $('cName').value = c.name; $('cUrl').value = c.baseUrl; $('cProto').value = c.protocol; $('cModel').value = c.model;
      $('cKey').value = ''; $('cKey').placeholder = c.hasKey ? 'Leave blank to keep the saved key' : 'Paste your key';
      $('cRemember').checked = !!c.remember; $('cFormTitle').textContent = `Edit ${c.name}`;
      $('cForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') { items = msg.connections || []; secureKeys = !!msg.secureKeyStorage; health = msg.health || []; renderProviders(); renderList(); resetForm(); }
    else if (msg.type === 'health') { health = msg.health || []; renderProviders(); }
    else if (msg.type === 'connections') { items = msg.items || []; renderList(); $('cStatus').textContent = msg.text || ''; }
    else if (msg.type === 'connectionSaved') { $('cId').value = msg.id; $('cFormTitle').textContent = 'Edit connection'; }
    else if (msg.type === 'connectionError') { $('cStatus').textContent = msg.text; $('cStatus').classList.add('bad'); }
    else if (msg.type === 'connectionTestResult') { results[msg.id] = { ok: msg.ok, text: msg.text }; renderList(); }
    else if (msg.type === 'cliSignInOpened') { window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' })); toast('Sign-in opened in a new pane. Follow the steps there.', 'key'); }
  });
})();
