/* Real desktop workbench. Uses the existing terminal/compare/history runtime. */
(() => {
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rail=document.createElement('aside');rail.id='workbench-rail';
  rail.innerHTML='<img src="/brand-logo.png" alt="VibeDeck"><div id="project-slot"></div><button id="workspace-view" class="rail-active">Workbench</button><button id="pipeline-view">Pipelines</button><button id="saved-view">Saved rounds</button><div class="rail-bottom">Different minds.<br>Shared momentum.<small>Local desktop workspace</small></div>';
  document.body.prepend(rail);document.querySelector('#project-slot').append($('cwdBtn'));
  const heading=document.createElement('section');heading.id='workbench-heading';heading.innerHTML='<p>Your local AI workspace</p><h1>A little more perspective.</h1><span>Work side by side, compare approaches, or build your own pipeline.</span>';
  $('app').prepend(heading);
  document.querySelector('#deck .brand').hidden=true;
  $('pipeline').closest('.selwrap').hidden=true;
  const composer=document.createElement('footer');composer.id='workbench-composer';composer.innerHTML='<label for="prompt">What are we working on?</label>';
  composer.append(document.querySelector('.promptwrap'));
  const broadcast=document.createElement('button');broadcast.textContent='Broadcast prompt';broadcast.className='primary-action';broadcast.onclick=()=>promptEl.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));composer.append(broadcast);
  $('app').append(composer);
  const empty=document.createElement('section');empty.id='empty-workspace';empty.hidden=true;empty.innerHTML='<h2>Choose your first coding tool.</h2><p>Install and sign in to a CLI, then add its terminal here. Pipelines are available from the sidebar.</p><button data-add-cli="claude">Add Claude</button> <button data-add-cli="codex">Add Codex</button> <button data-add-cli="shell">Open shell</button>';$('main').prepend(empty);empty.addEventListener('click',event=>{if(event.target.dataset.addCli)send({type:'add',kind:event.target.dataset.addCli});});
  const panel=document.createElement('section');panel.id='pipeline-builder';panel.hidden=true;
  panel.innerHTML=`<header><div><h2>Your lineup. Your workflow.</h2><p>Choose each stage, then review its answer before handing off.</p></div><label>Saved pipelines<select id="saved-pipeline"><option value="">Choose a pipeline</option></select></label></header><div class="pipeline-naming"><label>Pipeline name<input id="custom-name" maxlength="80" value="Plan, build, review"></label><button id="save-pipeline">Save pipeline</button><button id="add-stage">Add stage</button></div><div id="custom-stages"></div><label class="pipeline-request">What should this pipeline do?<textarea id="pipeline-prompt" rows="3" maxlength="32000" placeholder="Describe the feature, fix or review you want to complete."></textarea></label><p class="pipeline-permissions">Plan and Review run without file edits. Build can edit project files using your CLI permissions. Each handoff waits for you.</p><div class="pipeline-actions"><button id="run-custom" class="primary-action">Run pipeline</button><button id="resume-custom" hidden>Approve and continue</button><button id="cancel-custom" hidden>Stop pipeline</button></div><p id="custom-status" role="status">Ready. Uses your installed and authenticated Claude or Codex CLI.</p><div id="stage-answers"></div>`;
  $('main').append(panel);
  let definitions=[], status={state:'idle',outputs:[]};
  let steps=[{role:'Plan',kind:'codex',model:'gpt-6-astra'},{role:'Build',kind:'claude',model:''},{role:'Review',kind:'codex',model:'gpt-6-astra'}];
  const busy=()=>['running','waiting','cancelling'].includes(status.state);
  function renderStages(){
    $('custom-stages').innerHTML=steps.map((s,i)=>`<article class="custom-stage ${s.kind}"><small>Stage ${i+1}</small><label>Role<select data-index="${i}" data-field="role">${['Plan','Build','Review'].map(r=>`<option ${r===s.role?'selected':''}>${r}</option>`).join('')}</select></label><label>Run with<select data-index="${i}" data-field="kind"><option value="codex" ${s.kind==='codex'?'selected':''}>Codex</option><option value="claude" ${s.kind==='claude'?'selected':''}>Claude</option></select></label><label>Model<input data-index="${i}" data-field="model" value="${escape(s.model)}" placeholder="CLI default" list="models-${i}" maxlength="100"><datalist id="models-${i}">${(s.kind==='codex'?['gpt-6-astra']:['sonnet','opus','haiku']).map(m=>`<option value="${m}"></option>`).join('')}</datalist></label><button data-remove="${i}" ${steps.length===1?'disabled':''}>Remove stage</button></article>`).join('');
    panel.querySelectorAll('#custom-stages input,#custom-stages select,#custom-stages button').forEach(el=>el.disabled=busy()||(el.hasAttribute('data-remove')&&steps.length===1));
  }
  function view(pipeline){empty.hidden=pipeline||panes.size>0;panel.hidden=!pipeline;$('panes').hidden=pipeline;$('workbench-composer').hidden=pipeline;$('workspace-view').classList.toggle('rail-active',!pipeline);$('pipeline-view').classList.toggle('rail-active',pipeline);if(!pipeline)fitAll();}
  $('workspace-view').onclick=()=>view(false);$('pipeline-view').onclick=()=>view(true);$('saved-view').onclick=()=>$('histBtn').click();
  panel.addEventListener('change',e=>{if(!e.target.dataset.field||busy())return;const i=Number(e.target.dataset.index);steps[i][e.target.dataset.field]=e.target.value;if(e.target.dataset.field==='kind'){steps[i].model='';renderStages();}});
  panel.addEventListener('click',e=>{if(e.target.dataset.remove!==undefined&&!busy()&&steps.length>1){steps.splice(Number(e.target.dataset.remove),1);renderStages();}});
  $('add-stage').onclick=()=>{if(steps.length<8&&!busy()){steps.push({role:'Review',kind:'codex',model:''});renderStages();}};
  const definition=()=>({name:$('custom-name').value,steps:steps.map(s=>({...s}))});
  $('save-pipeline').onclick=()=>send({type:'customPipelineSave',definition:definition()});
  $('run-custom').onclick=()=>send({type:'customPipelineStart',definition:definition(),prompt:$('pipeline-prompt').value});
  $('resume-custom').onclick=()=>send({type:'customPipelineResume'});
  $('cancel-custom').onclick=()=>send({type:'customPipelineCancel'});
  $('saved-pipeline').onchange=()=>{if($('saved-pipeline').value==='')return;const def=definitions[Number($('saved-pipeline').value)];if(!def||busy())return;steps=def.steps.map(s=>({...s}));$('custom-name').value=def.name;renderStages();};
  function renderDefinitions(){ $('saved-pipeline').innerHTML='<option value="">Choose a pipeline</option>'+definitions.map((d,i)=>`<option value="${i}">${escape(d.name)}</option>`).join(''); }
  function renderStatus(){
    const labels={idle:'Ready.',cancelling:'Stopping the active process.',running:`Running stage ${(status.index||0)+1}: ${status.step?.role} with ${status.step?.kind}.`,waiting:`Review the answer below. Next: ${status.step?.role} with ${status.step?.kind}.`,done:'Pipeline complete. Results saved in your history.',cancelled:'Pipeline stopped.',error:'Pipeline stopped with an error.'};
    $('custom-status').textContent=labels[status.state]+(status.text?' '+status.text:'');
    $('resume-custom').hidden=status.state!=='waiting';$('cancel-custom').hidden=!busy();$('run-custom').disabled=busy();
    ['custom-name','save-pipeline','add-stage','saved-pipeline','pipeline-prompt'].forEach(id=>$(id).disabled=busy());
    $('stage-answers').innerHTML=(status.outputs||[]).map(o=>`<article><h3>${escape(o.role)} · ${escape(o.kind)}${o.model?' · '+escape(o.model):''}</h3><pre>${escape(o.text)}</pre></article>`).join('');renderStages();
  }
  ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);
    if(['init','paneAdded','paneRemoved','paneReplaced'].includes(msg.type))empty.hidden=!panel.hidden||panes.size>0;
    if(msg.type==='init'){definitions=msg.customDefinitions||[];status=msg.customStatus||status;renderDefinitions();renderStatus();}
    if(msg.type==='customDefinitions'){definitions=msg.items;renderDefinitions();$('custom-status').textContent='Pipeline saved on this computer.';}
    if(msg.type==='customPipelineStatus'){status=msg;renderStatus();}
    if(msg.type==='answerFailed')toast(msg.text);
    if(msg.type==='roundFailed')toast('Some terminals failed or timed out. Review partial results.');
    if(msg.type==='customPipelineError'){$('custom-status').textContent=msg.text;toast(msg.text);}
  });
  renderStages();
})();

