// Pipelines page: build a chain of stages, run it, review every handoff.
(() => {
  const root = $('view-pipelines');
  const ROLES = {
    Plan: 'Reads the project, writes a plan. No file changes.',
    Build: 'Makes the file changes.',
    Review: 'Checks the work. No file changes.',
  };
  const DRAFT_KEY = 'vibedeck-pipeline-draft';
  let definitions = [], templates = [], apiConnections = [];
  let status = { state: 'idle', outputs: [] }, activity = [];
  let openAnswers = new Set(), editing = false;
  let draft = null;
  try { draft = JSON.parse(load(DRAFT_KEY)); } catch {}
  if (!draft || !Array.isArray(draft.steps) || !draft.steps.length) draft = null;

  const active = () => ['running', 'waiting', 'cancelling'].includes(status.state);
  const saveDraft = () => store(DRAFT_KEY, JSON.stringify(draft));
  const providerLabel = step => step.kind === 'api'
    ? (apiConnections.find(c => c.id === step.connectionId)?.name || 'API connection')
    : kindName(step.kind);
  const modelName = (kind, id) => (modelsCfg[kind]?.labels || {})[id] || id;
  const stepLabel = step => `${providerLabel(step)}, ${step.model ? modelName(step.kind, step.model) : 'default model'}${step.effort ? ', ' + (modelsCfg[step.kind]?.labels?.[step.effort] || step.effort) + ' effort' : ''}${step.commands ? ', can run commands' : ''}`;
  // did the CLI run on what the stage asked for? grok answers with its "-build" variant of the same model
  const ranMatches = (step, ranOn) => !step.model || !ranOn || ranOn === step.model || ranOn.startsWith(step.model + '-') || (step.model === 'grok-4.7-build-fast' && ranOn.startsWith('grok-4.7-build-fast'));
  window.vdRanTag = (step, ranOn) => !ranOn ? '' : ranMatches(step, ranOn)
    ? `<span class="tag" title="The CLI reported running on this model">Ran on ${esc(ranOn)}</span>`
    : `<span class="tag edited" title="The stage asked for ${esc(step.model)}">Asked for ${esc(step.model)}, ran on ${esc(ranOn)}</span>`;
  const cleanDef = () => ({ name: draft.name, steps: draft.steps.map(s => ({ kind: s.kind, role: s.role, model: s.model || '', effort: s.kind === 'api' ? '' : s.effort || '', commands: !!s.commands && s.role === 'Build', instructions: s.instructions || '', ...(s.kind === 'api' ? { connectionId: s.connectionId } : {}) })) });

  // tiny, safe markdown: escape first, then fences, inline code, bold and headings
  function md(text) {
    const parts = String(text).split(/```[^\n]*\n?/);
    return parts.map((chunk, i) => {
      const e = esc(chunk);
      if (i % 2) return `<pre class="mdcode">${e.replace(/\n$/, '')}</pre>`;
      return e.replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4}\s+(.+)$/gm, '<b class="mdh">$1</b>');
    }).join('');
  }

  window.vdMd = md;

  // ---------- page skeleton ----------
  root.innerHTML = `
    <div class="pl-top">
      <div class="title">
        <div class="eyebrow">Pipeline</div>
        <input class="pl-name" id="plName" maxlength="80" spellcheck="false" aria-label="Pipeline name">
      </div>
      <select class="select" id="plLoad" title="Load a saved or starter pipeline"></select>
      <button class="btn" id="plSave">${ICONS.save}Save</button>
      <button class="btn ghost" id="plDelete" title="Delete this saved pipeline">${ICONS.trash}</button>
    </div>
    <div class="flow" id="plFlow"></div>
    <div class="card request">
      <div class="rq">
        <div class="eyebrow">Request</div>
        <textarea id="plPrompt" rows="2" maxlength="32000" placeholder="Describe the feature, fix or question. Every stage sees this plus the earlier stages' answers."></textarea>
      </div>
      <div class="side">
        <div class="where" id="plWhere"></div>
        <label class="switch" title="Run every stage back to back without stopping for your review"><input type="checkbox" id="plAuto">Auto-approve handoffs</label>
        <button class="btn primary" id="plRun">${ICONS.play}Run pipeline</button>
      </div>
    </div>
    <div class="card runp" id="plRun2" hidden></div>
    <details class="more"><summary>How pipelines work</summary>
      <p>Each stage runs its CLI on its own in your project folder, one after another. Plan and Review stages can read files but not change them. Build stages can edit files, using the CLI's own permission rules. API and local-model stages only see the text you send them and cannot touch files. After each stage you see its answer and decide whether to continue, add a note, edit what gets handed on, or redo the stage.</p>
    </details>`;

  // ---------- builder ----------
  function providerOptions(step) {
    const h = kind => (window.vdHealth || []).find(x => x.id === kind);
    const cli = ['claude', 'codex', 'grok'].map(k => `<option value="${k}" ${step.kind === k ? 'selected' : ''}>${kindName(k)} CLI${h(k) && !h(k).ok ? ' (not installed)' : ''}</option>`).join('');
    const api = apiConnections.map(c => `<option value="api:${esc(c.id)}" ${step.kind === 'api' && step.connectionId === c.id ? 'selected' : ''}>API: ${esc(c.name)}</option>`).join('');
    return cli + (api ? `<optgroup label="API and local models">${api}</optgroup>` : '<option value="api:" disabled>API model (add one in Connections)</option>');
  }
  function modelFields(s) {
    const cfg = modelsCfg[s.kind] || { models: [], efforts: [], labels: {} };
    const custom = s.customModel || (s.model && !cfg.models.includes(s.model));
    const models = cfg.models.map(id => `<option value="${esc(id)}" ${!custom && s.model === id ? 'selected' : ''}>${esc(cfg.labels[id] || id)}</option>`).join('');
    const efforts = cfg.efforts.map(id => `<option value="${esc(id)}" ${s.effort === id ? 'selected' : ''}>${esc(cfg.labels[id] || id)}</option>`).join('');
    return `<div class="two">
      <label class="field"><span>Model</span><select class="select" data-f="modelSel">
        <option value="" ${!custom && !s.model ? 'selected' : ''}>Default${cfg.defaultLabel ? ' (' + esc(cfg.defaultLabel) + ')' : ''}</option>${models}
        <option value="__custom" ${custom ? 'selected' : ''}>Other model ID</option></select></label>
      <label class="field"><span>Effort</span><select class="select" data-f="effort"><option value="">Default</option>${efforts}</select></label></div>
      ${s.role === 'Build' && s.kind !== 'codex' ? `<label class="switch" title="Lets this stage run terminal commands (tests, installs, builds) without asking. Off: it can only read and edit files."><input type="checkbox" data-f="commands" ${s.commands ? 'checked' : ''}>Can run commands, like tests</label>` : ''}
      ${s.role === 'Build' && s.kind === 'codex' ? '<span class="role-hint">Codex runs commands inside its own sandbox.</span>' : ''}
      ${custom ? `<input class="input mono" data-f="model" maxlength="150" value="${esc(s.model || '')}" placeholder="Exact model ID, like claude-opus-4-5" spellcheck="false">` : ''}`;
  }
  function modelChoices(step) {
    if (step.kind === 'api') return [];
    return (modelsCfg[step.kind]?.models || []);
  }
  function renderFlow() {
    const flow = $('plFlow');
    const cards = draft.steps.map((s, i) => {
      const h = (window.vdHealth || []).find(x => x.id === s.kind);
      const missing = s.kind !== 'api' && h && !h.ok;
      const noConn = s.kind === 'api' && !apiConnections.some(c => c.id === s.connectionId);
      const conn = apiConnections.find(c => c.id === s.connectionId);
      return `${i ? `<div class="arrow">${ICONS.arrow}</div>` : ''}
      <article class="stage" style="--kind:${color(s.kind)}" data-i="${i}">
        <div class="stage-top">
          <span class="num">${i + 1}</span>
          <select class="role" data-f="role" title="What this stage does">${Object.keys(ROLES).map(r => `<option ${r === s.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <span class="stage-actions">
            <button class="iconbtn" data-act="left" title="Move earlier" ${i === 0 ? 'disabled' : ''}>${ICONS.left}</button>
            <button class="iconbtn" data-act="right" title="Move later" ${i === draft.steps.length - 1 ? 'disabled' : ''}>${ICONS.right}</button>
            <button class="iconbtn" data-act="remove" title="Remove stage" ${draft.steps.length === 1 ? 'disabled' : ''}>${ICONS.x}</button>
          </span>
        </div>
        <div class="role-hint">${ROLES[s.role]}</div>
        <label class="field"><span>Provider</span><select class="select" data-f="provider">${providerOptions(s)}</select>
          ${missing ? `<span class="warn">This CLI is not installed on this computer.</span>` : ''}${noConn ? `<span class="warn">Choose a saved API connection.</span>` : ''}</label>
        ${s.kind === 'api'
          ? `<label class="field"><span>Model <em>blank uses the connection default</em></span>
              <input class="input mono" data-f="model" maxlength="150" value="${esc(s.model || '')}" placeholder="${esc(conn?.model || 'default')}" spellcheck="false"></label>`
          : modelFields(s)}
        <label class="field"><span>Instructions <em>optional</em></span>
          <textarea class="textarea" data-f="instructions" maxlength="4000" rows="2" placeholder="Anything special for this stage">${esc(s.instructions || '')}</textarea></label>
      </article>`;
    }).join('');
    flow.innerHTML = cards + `<button class="add-stage" id="plAdd" ${draft.steps.length >= 8 ? 'disabled' : ''}>${ICONS.plus}<span>Add stage</span></button>`;
  }
  function renderTop() {
    $('plName').value = draft.name;
    const saved = definitions.map((d, i) => `<option value="s${i}">${esc(d.name)}</option>`).join('');
    const starters = templates.map((d, i) => `<option value="t${i}">${esc(d.name)}</option>`).join('');
    $('plLoad').innerHTML = '<option value="">Load a pipeline</option>'
      + (saved ? `<optgroup label="Saved">${saved}</optgroup>` : '')
      + (starters ? `<optgroup label="Starters">${starters}</optgroup>` : '')
      + '<option value="new">Start from scratch</option>';
    $('plDelete').hidden = !definitions.some(d => d.name === draft.name.trim());
  }
  function renderWhere() {
    const el = $('plWhere');
    el.classList.toggle('warn', needsFolder);
    el.textContent = needsFolder ? 'Choose a project folder first' : `Runs in ${cwd}`;
    el.title = needsFolder ? '' : cwd;
    $('plRun').disabled = active();
  }
  function renderBuilder() { renderTop(); renderFlow(); renderWhere(); }

  root.addEventListener('input', e => {
    const card = e.target.closest('.stage');
    if (e.target.id === 'plName') { draft.name = e.target.value; $('plDelete').hidden = !definitions.some(d => d.name === draft.name.trim()); saveDraft(); }
    else if (e.target.id === 'plPrompt') { draft.prompt = e.target.value; saveDraft(); }
    else if (card && ['model', 'instructions'].includes(e.target.dataset.f)) { draft.steps[Number(card.dataset.i)][e.target.dataset.f] = e.target.value; saveDraft(); }
  });
  root.addEventListener('change', e => {
    const card = e.target.closest('.stage');
    if (!card) return;
    const step = draft.steps[Number(card.dataset.i)];
    if (e.target.dataset.f === 'role') step.role = e.target.value;
    if (e.target.dataset.f === 'modelSel') {
      step.customModel = e.target.value === '__custom';
      step.model = step.customModel ? '' : e.target.value;
    }
    if (e.target.dataset.f === 'effort') step.effort = e.target.value;
    if (e.target.dataset.f === 'commands') step.commands = e.target.checked;
    if (e.target.dataset.f === 'provider') {
      step.effort = ''; step.customModel = false;
      const [kind, id] = e.target.value.split(':');
      step.kind = kind; step.model = '';
      if (kind === 'api') step.connectionId = id; else delete step.connectionId;
    }
    saveDraft(); renderFlow();
  });
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const card = b.closest('.stage');
    if (card && b.dataset.act) {
      const i = Number(card.dataset.i), s = draft.steps;
      if (b.dataset.act === 'remove' && s.length > 1) s.splice(i, 1);
      if (b.dataset.act === 'left' && i > 0) [s[i - 1], s[i]] = [s[i], s[i - 1]];
      if (b.dataset.act === 'right' && i < s.length - 1) [s[i + 1], s[i]] = [s[i], s[i + 1]];
      saveDraft(); renderFlow(); return;
    }
    if (b.id === 'plAdd' && draft.steps.length < 8) {
      const last = draft.steps[draft.steps.length - 1];
      draft.steps.push({ role: 'Review', kind: last?.kind === 'codex' ? 'claude' : 'codex', model: '', instructions: '' });
      saveDraft(); renderFlow();
      $('plFlow').scrollLeft = $('plFlow').scrollWidth;
    }
  });
  $('plLoad').addEventListener('change', () => {
    const v = $('plLoad').value;
    $('plLoad').value = '';
    let def = null;
    if (v === 'new') def = { name: 'New pipeline', steps: [{ role: 'Plan', kind: 'claude', model: '' }] };
    else if (v[0] === 's') def = definitions[Number(v.slice(1))];
    else if (v[0] === 't') def = templates[Number(v.slice(1))];
    if (!def) return;
    draft = { name: def.name, prompt: draft.prompt || '', steps: def.steps.map(s => ({ ...s, instructions: s.instructions || '' })) };
    saveDraft(); renderBuilder();
  });
  $('plSave').addEventListener('click', () => {
    if (!draft.name.trim()) { toast('Give the pipeline a name first.', 'info'); return $('plName').focus(); }
    send({ type: 'customPipelineSave', definition: cleanDef() });
  });
  $('plDelete').addEventListener('click', () => send({ type: 'customPipelineDelete', name: draft.name.trim() }));
  $('plRun').addEventListener('click', () => {
    const prompt = $('plPrompt').value;
    if (!prompt.trim()) { toast('Write what the pipeline should do first.', 'info'); return $('plPrompt').focus(); }
    if (needsFolder && draft.steps.some(s => s.kind !== 'api')) { toast('Choose a project folder first. CLI stages work inside it.', 'folder'); return $('cwdBtn').click(); }
    openAnswers = new Set(); editing = false;
    send({ type: 'customPipelineStart', definition: cleanDef(), prompt, autoApprove: $('plAuto').checked });
  });
  $('plPrompt').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) $('plRun').click(); });

  // ---------- run panel ----------
  const since = ts => `data-since="${ts || 0}"`;
  function logHtml() {
    const start = status.stageStartedAt || Date.now();
    const lines = activity.slice(-60);
    if (!lines.length) return `<div class="idle">Starting ${esc(providerLabel(status.step || {}))}. The first activity can take a few seconds.</div>`;
    return lines.map((a, i) => `<div class="${i === lines.length - 1 && status.state === 'running' ? 'now' : ''}"><span class="lt">${fmtClock(a.t - start)}</span>${esc(a.line)}</div>`).join('');
  }
  function renderRun() {
    const box = $('plRun2');
    const st = status.state;
    box.hidden = st === 'idle';
    renderWhere();
    const nav = $('navPipeCnt');
    nav.textContent = st === 'running' || st === 'cancelling' ? 'Running' : st === 'waiting' ? 'Review' : st === 'error' ? 'Failed' : '';
    nav.classList.toggle('live', active());
    if (st === 'idle') return;
    const steps = status.steps || [];
    const outs = status.outputs || [];
    const next = steps[status.index];
    const first = (status.request || '').split('\n').find(l => l.trim()) || status.name;
    const banner = st === 'waiting'
      ? `<div class="run-banner wait">${ICONS.info}<span>Stage ${outs.length} is done. Read its answer below, then approve to hand off to stage ${outs.length + 1} (${esc(next?.role)}, ${esc(providerLabel(next || {}))}).</span></div>`
      : st === 'error' ? `<div class="run-banner bad">${ICONS.warn}<span>Stage ${status.index + 1} failed: ${esc(status.text)}</span></div>`
      : st === 'done' ? `<div class="run-banner ok">${ICONS.check}<span>All ${steps.length} stages finished${status.stageStartedAt ? '' : ''}. The run is saved in History.</span></div>`
      : st === 'cancelled' ? `<div class="run-banner bad">${ICONS.stop}<span>${esc(status.text || 'Pipeline stopped.')}</span></div>` : '';
    const headBtns = active()
      ? `<label class="switch" title="Continue through the remaining stages without stopping"><input type="checkbox" id="runAuto" ${status.autoApprove ? 'checked' : ''} ${st === 'cancelling' ? 'disabled' : ''}>Auto-approve</label>
         ${st === 'waiting' ? '' : `<button class="btn danger ghost" id="runStop" ${st === 'cancelling' ? 'disabled' : ''}>${ICONS.stop}${st === 'cancelling' ? 'Stopping' : 'Stop'}</button>`}`
      : `${st === 'error' ? `<button class="btn primary" id="runRetry">${ICONS.restart}Retry stage ${status.index + 1}</button>` : ''}
         <button class="btn" id="runHistory">${ICONS.clock}Open in History</button>
         <button class="btn ghost" id="runDismiss">${ICONS.x}Clear</button>`;
    const rows = steps.map((s, i) => {
      const out = outs[i];
      const head = (badge, cls, right) => `<div class="step-h">${badge}<span class="step-t">${esc(s.role)}<b>${esc(stepLabel(s))}</b></span><span class="grow"></span>${right || ''}</div>`;
      if (out) {
        const isHandoff = st === 'waiting' && i === outs.length - 1;
        const open = openAnswers.has(i) || isHandoff;
        return `<div class="step ${isHandoff ? 'waiting' : 'done'}" data-i="${i}">
          ${head(`<span class="badge ok">${ICONS.check}</span>`, '', `${window.vdRanTag(s, out.ranOn)}${out.edited ? '<span class="tag edited">Edited</span>' : ''}<span class="tm">${fmtClock(out.ms || 0)}</span>
            <button class="btn sm ghost" data-act="copy">${ICONS.copy}Copy</button>
            ${isHandoff ? '' : `<button class="btn sm ghost" data-act="toggle">${open ? 'Collapse' : 'Show answer'}</button>`}`)}
          ${isHandoff && editing
            ? `<div class="handoff"><div class="eyebrow">Edit what gets handed to the next stage</div><textarea class="textarea edit" id="runEditText">${esc(out.text)}</textarea></div>`
            : `<div class="answer ${open ? 'open' : ''}">${md(out.text)}</div>`}
          ${isHandoff ? `<div class="handoff">
              <label class="field"><span>Note for the next stage <em>optional</em></span><textarea class="textarea" id="runNote" rows="2" maxlength="4000" placeholder="For example: skip the database changes, focus on the UI"></textarea></label>
              <div class="row">
                <button class="btn primary" id="runApprove">${ICONS.check}Approve and continue</button>
                <button class="btn" id="runEdit">${ICONS.edit}${editing ? 'Stop editing' : 'Edit handoff'}</button>
                <button class="btn" id="runRedo" title="Run this stage again. Your note is passed to it.">${ICONS.restart}Redo this stage</button>
                <span class="grow"></span>
                <button class="btn ghost danger" id="runStop2">${ICONS.stop}Stop pipeline</button>
              </div></div>` : ''}
        </div>`;
      }
      if (i === status.index && (st === 'running' || st === 'cancelling')) {
        return `<div class="step running" data-i="${i}">
          ${head('<span class="badge spin"></span>', '', `<span class="tm live" ${since(status.stageStartedAt)}>${fmtClock(Date.now() - (status.stageStartedAt || Date.now()))}</span>`)}
          <div class="log" id="runLog">${logHtml()}</div></div>`;
      }
      if (i === status.index && st === 'error') {
        return `<div class="step error" data-i="${i}">${head(`<span class="badge bad">${ICONS.x}</span>`, '', '<span class="tm">Failed</span>')}
          ${activity.length ? `<div class="log">${logHtml()}</div>` : ''}</div>`;
      }
      const waitText = st === 'cancelled' || st === 'error' ? 'Not run' : status.autoApprove ? 'Queued' : 'Waits for your approval';
      return `<div class="step" data-i="${i}">${head(`<span class="badge q">${i + 1}</span>`, '', `<span class="tm">${waitText}</span>`)}</div>`;
    }).join('');
    const total = st === 'done' || st === 'cancelled' || st === 'error' ? '' : `<span class="elapsed">${ICONS.clock}<span ${since(status.startedAt)}>${fmtClock(Date.now() - (status.startedAt || Date.now()))}</span></span>`;
    box.innerHTML = `<div class="run-head"><div class="t"><div class="eyebrow">${active() ? 'Live run' : 'Last run'}: ${esc(status.name)}</div><h3 title="${esc(status.request)}">${esc(first)}</h3></div>${total}${headBtns}</div>${banner}<div class="steps">${rows}</div>`;
    const log = $('runLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
  function updateLog() {
    const log = $('runLog');
    if (!log) return;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = logHtml();
    if (stick) log.scrollTop = log.scrollHeight;
  }
  setInterval(() => {
    document.querySelectorAll('#plRun2 [data-since]').forEach(el => { const t = Number(el.dataset.since); if (t) el.textContent = fmtClock(Date.now() - t); });
  }, 1000);

  $('plRun2').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'runStop' || b.id === 'runStop2') send({ type: 'customPipelineCancel' });
    else if (b.id === 'runApprove') {
      const editedOutput = editing ? $('runEditText')?.value : undefined;
      send({ type: 'customPipelineResume', note: $('runNote')?.value || '', editedOutput });
      editing = false;
    } else if (b.id === 'runRedo') { send({ type: 'customPipelineRetry', note: $('runNote')?.value || '' }); editing = false; }
    else if (b.id === 'runEdit') { const note = $('runNote')?.value; editing = !editing; renderRun(); if (note && $('runNote')) $('runNote').value = note; }
    else if (b.id === 'runRetry') send({ type: 'customPipelineRetry' });
    else if (b.id === 'runDismiss') send({ type: 'customPipelineDismiss' });
    else if (b.id === 'runHistory') { window.dispatchEvent(new CustomEvent('vd:openRun', { detail: status.id })); }
    else if (b.dataset.act) {
      const i = Number(b.closest('.step').dataset.i), out = status.outputs[i];
      if (b.dataset.act === 'copy' && out) { navigator.clipboard.writeText(out.text); toast('Answer copied', 'copy'); }
      if (b.dataset.act === 'toggle') { openAnswers.has(i) ? openAnswers.delete(i) : openAnswers.add(i); renderRun(); }
    }
  });
  $('plRun2').addEventListener('change', e => { if (e.target.id === 'runAuto') send({ type: 'customPipelineAuto', on: e.target.checked }); });

  // ---------- server messages ----------
  let lastState = 'idle';
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      definitions = msg.customDefinitions || []; templates = msg.templates || []; apiConnections = msg.connections || [];
      status = msg.customStatus || status; activity = status.activity || [];
      lastState = status.state;
      if (!draft) {
        const t = templates.find(x => x.name === 'Plan, build, review') || templates[0] || { name: 'Plan, build, review', steps: [{ role: 'Plan', kind: 'codex' }, { role: 'Build', kind: 'claude' }, { role: 'Review', kind: 'codex' }] };
        draft = { name: t.name, prompt: '', steps: t.steps.map(s => ({ ...s, model: s.model || '', instructions: s.instructions || '' })) };
      }
      $('plPrompt').value = draft.prompt || '';
      renderBuilder(); renderRun();
    } else if (msg.type === 'customDefinitions') {
      definitions = msg.items || [];
      renderTop();
      if (msg.saved) toast(`Saved "${msg.saved}"`, 'save');
    } else if (msg.type === 'connections') {
      apiConnections = msg.items || [];
      renderFlow();
    } else if (msg.type === 'customPipelineStatus') {
      const prev = status;
      status = msg;
      if (msg.state === 'running' && (prev.index !== msg.index || prev.state !== 'running' || prev.id !== msg.id)) activity = msg.activity || [];
      if (msg.state !== 'waiting') editing = false;
      renderRun();
      if (msg.state !== lastState) {
        const onPage = !$('view-pipelines').hidden;
        if (msg.state === 'waiting' && !onPage) toast(`Pipeline stage ${msg.outputs.length} is done. Review it in Pipelines.`, 'chain');
        if (msg.state === 'done') toast(`Pipeline "${msg.name}" finished.`, 'check');
        if (msg.state === 'error') toast(`Pipeline stage failed: ${msg.text}`, 'warn', true);
      }
      lastState = msg.state;
    } else if (msg.type === 'pipelineActivity') {
      if (msg.id === status.id && msg.index === status.index) { activity = msg.activity || []; updateLog(); }
    } else if (msg.type === 'customPipelineError') {
      toast(msg.text, 'warn', true);
    } else if (msg.type === 'models') {
      renderFlow();
    }
  });
  window.addEventListener('vd:cwd', renderWhere);
  window.addEventListener('vd:health', renderFlow);
  window.addEventListener('vd:usePipeline', e => {
    draft = { name: e.detail.name, prompt: draft?.prompt || '', steps: e.detail.steps };
    saveDraft(); renderBuilder();
    window.dispatchEvent(new CustomEvent('vd:view', { detail: 'pipelines' }));
    $('plPrompt').focus();
  });
})();
