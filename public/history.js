// History page: finished pipeline runs, broadcast rounds, and past prompts.
(() => {
  const root = $('view-history');
  let runs = [], tab = 'runs', filter = '', openRun = null;

  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">History</div><h2>Everything you've run</h2></div></div>
    <div class="tabs" id="hTabs">
      <button data-tab="runs">Pipeline runs<span class="cnt" id="hcRuns"></span></button>
      <button data-tab="rounds">Broadcast rounds<span class="cnt" id="hcRounds"></span></button>
      <button data-tab="prompts">Prompts<span class="cnt" id="hcPrompts"></span></button>
    </div>
    <div class="hist-bar"><input class="input" id="hSearch" placeholder="Search" spellcheck="false"></div>
    <div id="hBody"></div>`;

  const match = text => !filter || String(text || '').toLowerCase().includes(filter);
  const chip = (kind, label, win) => `<span class="chip ${win ? 'win' : ''}">${win ? ICONS.award : `<i style="background:${color(kind)}"></i>`}${esc(label)}</span>`;

  function renderRuns(body) {
    if (openRun) return renderRunDetail(body, openRun);
    const items = [...runs].reverse().filter(r => match(r.request) || match(r.name));
    body.innerHTML = items.length ? `<div class="hist-list">${items.map(r => `
      <div class="h-item" data-id="${r.id}">
        <span class="h-ts">${esc(fmtWhen(r.ts))}</span>
        <span class="h-text">${esc((r.request || '').split('\n')[0])}<span class="h-sub">${esc(r.name)}</span></span>
        <span class="chips">${(r.steps || []).map(s => chip(s.kind, s.role, false)).join('')}</span>
        <span class="state-pill ${esc(r.state)}">${r.state === 'done' ? 'Finished' : r.state === 'error' ? 'Failed' : 'Stopped'}</span>
      </div>`).join('')}</div>`
      : `<div class="empty">${filter ? 'Nothing matches that search.' : 'No pipeline runs yet. Build one in Pipelines and it will show up here.'}</div>`;
  }
  function renderRunDetail(body, run) {
    const dur = run.finishedAt && run.ts ? fmtClock(run.finishedAt - run.ts) : '';
    body.innerHTML = `<div class="detail">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn sm" data-act="back">${ICONS.left}All runs</button>
        <span class="grow"></span>
        <button class="btn sm" data-act="copyAll">${ICONS.copy}Copy everything</button>
        <button class="btn sm primary" data-act="again">${ICONS.play}Run again</button>
      </div>
      <div><div class="eyebrow">${esc(run.name)}, ${esc(fmtWhen(run.ts))}${dur ? ', took ' + dur : ''}</div>
        <div class="card req" style="margin-top:6px">${esc(run.request)}</div></div>
      ${run.error ? `<div class="run-banner bad">${ICONS.warn}<span>${esc(run.error)}</span></div>` : ''}
      <div class="steps">${(run.steps || []).map((s, i) => {
        const o = run.outputs[i];
        return `<div class="step ${o ? 'done' : ''}"><div class="step-h">${o ? `<span class="badge ok">${ICONS.check}</span>` : `<span class="badge q">${i + 1}</span>`}
          <span class="step-t">${esc(s.role)}<b>${esc(kindName(s.kind))}, ${s.model ? esc((modelsCfg[s.kind]?.labels || {})[s.model] || s.model) : 'default model'}${s.effort ? ', ' + esc(s.effort) + ' effort' : ''}</b></span><span class="grow"></span>
          ${o && window.vdRanTag ? window.vdRanTag(s, o.ranOn) : ''}${o?.edited ? '<span class="tag edited">Edited</span>' : ''}<span class="tm">${o ? fmtClock(o.ms || 0) : 'Not run'}</span>
          ${o ? `<button class="btn sm ghost" data-act="copy" data-i="${i}">${ICONS.copy}Copy</button>` : ''}</div>
          ${o ? `<div class="answer open">${window.vdMd ? window.vdMd(o.text) : esc(o.text)}</div>` : ''}</div>`;
      }).join('')}</div></div>`;
  }
  function renderRounds(body) {
    const items = [...rounds].reverse().filter(r => match(r.prompt));
    body.innerHTML = items.length ? `<div class="hist-list">${items.map((r, n) => `
      <div class="h-item" data-n="${n}">
        <span class="h-ts">${esc(fmtWhen(r.ts))}</span>
        <span class="h-text">${esc(r.prompt || '')}</span>
        <span class="chips">${(r.responses || []).map(x => chip(x.kind, kindName(x.kind), r.winnerKind && r.winnerKind === x.kind)).join('')}</span>
        <button class="btn sm ghost" data-act="compare">${ICONS.compare}Compare</button>
      </div>`).join('')}</div>`
      : `<div class="empty">${filter ? 'Nothing matches that search.' : 'No broadcast rounds yet. Send a prompt from the Workbench and every answer is kept here.'}</div>`;
    body._items = items;
  }
  function renderPrompts(body) {
    const items = [...history].reverse().filter(h => match(h.text));
    body.innerHTML = items.length ? `<div class="hist-list">${items.map((h, n) => `
      <div class="h-item" data-n="${n}" title="Load into the prompt">
        <span class="h-ts">${esc(fmtWhen(h.ts))}</span><span class="h-text">${esc(h.text)}</span>
        <button class="iconbtn" data-act="del" title="Delete">${ICONS.x}</button>
      </div>`).join('')}</div>`
      : `<div class="empty">${filter ? 'Nothing matches that search.' : 'No prompts yet.'}</div>`;
    body._items = items;
  }
  function render() {
    root.querySelectorAll('#hTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    $('hcRuns').textContent = runs.length || '';
    $('hcRounds').textContent = rounds.length || '';
    $('hcPrompts').textContent = history.length || '';
    const body = $('hBody');
    if (tab === 'runs') renderRuns(body); else if (tab === 'rounds') renderRounds(body); else renderPrompts(body);
  }

  $('hTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { tab = b.dataset.tab; openRun = null; render(); } });
  $('hSearch').addEventListener('input', e => { filter = e.target.value.toLowerCase(); openRun = null; render(); });
  $('hBody').addEventListener('click', e => {
    const body = $('hBody');
    const act = e.target.closest('[data-act]')?.dataset.act;
    const row = e.target.closest('.h-item');
    if (tab === 'runs') {
      if (openRun) {
        if (act === 'back') { openRun = null; render(); }
        else if (act === 'copy') { navigator.clipboard.writeText(openRun.outputs[Number(e.target.closest('[data-i]').dataset.i)].text); toast('Answer copied', 'copy'); }
        else if (act === 'copyAll') {
          navigator.clipboard.writeText(`Request:\n${openRun.request}\n\n` + openRun.outputs.map((o, i) => `--- Stage ${i + 1}: ${o.role} (${kindName(o.kind)}) ---\n${o.text}`).join('\n\n'));
          toast('Whole run copied', 'copy');
        } else if (act === 'again') {
          store('vibedeck-pipeline-draft', JSON.stringify({ name: openRun.name, prompt: openRun.request, steps: openRun.steps.map(s => ({ ...s, instructions: s.instructions || '' })) }));
          window.dispatchEvent(new CustomEvent('vd:usePipeline', { detail: { name: openRun.name, steps: openRun.steps.map(s => ({ ...s, instructions: s.instructions || '' })) } }));
          const p = $('plPrompt'); if (p) { p.value = openRun.request; p.dispatchEvent(new Event('input', { bubbles: true })); }
        }
        return;
      }
      if (row) { openRun = runs.find(r => String(r.id) === row.dataset.id) || null; render(); root.scrollTop = 0; }
    } else if (tab === 'rounds' && row) {
      const r = body._items[Number(row.dataset.n)];
      if (act === 'compare') renderCompare(r);
      else { promptEl.value = r.prompt || ''; sizePrompt(); window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' })); promptEl.focus(); }
    } else if (tab === 'prompts' && row) {
      const h = body._items[Number(row.dataset.n)];
      if (act === 'del') { send({ type: 'histdel', ts: h.ts }); history = history.filter(x => x.ts !== h.ts); render(); return; }
      promptEl.value = h.text; sizePrompt();
      window.dispatchEvent(new CustomEvent('vd:view', { detail: 'workbench' }));
      promptEl.focus();
    }
  });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') { runs = msg.runs || []; render(); }
    else if (msg.type === 'pipelineRunSaved') { runs = runs.filter(r => r.id !== msg.run.id); runs.push(msg.run); if (!$('view-history').hidden) render(); }
    else if (['roundSaved', 'crowned', 'hist'].includes(msg.type) && !$('view-history').hidden) setTimeout(render, 0);
  });
  window.addEventListener('vd:shown', e => { if (e.detail === 'history') render(); });
  window.addEventListener('vd:openRun', e => {
    tab = 'runs';
    openRun = runs.find(r => r.id === e.detail) || null;
    window.dispatchEvent(new CustomEvent('vd:view', { detail: 'history' }));
    render();
  });
})();
