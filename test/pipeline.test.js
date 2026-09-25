const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PipelineRunner,validatePipeline,stagePrompt,claudeActivity}=require('../lib/pipeline-runner');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const definition={name:'Astra to Claude',steps:[{role:'Plan',kind:'codex',model:'gpt-6-astra'},{role:'Build',kind:'claude',model:'',instructions:'Use the existing helpers.'}]};
const statuses=events=>events.filter(e=>e.type!=='activity');
test('validates providers, models, instructions and stage counts',()=>{
  const clean=validatePipeline(definition);
  assert.equal(clean.steps[0].model,'gpt-6-astra');
  assert.equal(clean.steps[1].instructions,'Use the existing helpers.');
  assert.equal('instructions' in clean.steps[0],false);
  for(const steps of [[],[{role:'Build',kind:'unsupported'}],[{role:'Build',kind:'codex',model:'x; whoami'}],[{role:'Build',kind:'codex',instructions:'x'.repeat(4001)}]])assert.throws(()=>validatePipeline({name:'Bad',steps}));
});
test('stage prompts carry the role brief, instructions, request, earlier output and user note',()=>{
  const prompt=stagePrompt({step:definition.steps[1],request:'Add a picker',outputs:[{role:'Plan',kind:'codex',text:'1. Do it'}],note:'Keep it small'});
  assert.match(prompt,/BUILDER/);assert.match(prompt,/Use the existing helpers/);assert.match(prompt,/Add a picker/);assert.match(prompt,/1\. Do it/);assert.match(prompt,/Keep it small/);
  assert.match(stagePrompt({step:{role:'Review',kind:'grok'},request:'x',outputs:[]}),/do not create, edit or delete/i);
});
test('claude stream events become readable activity lines',()=>{
  assert.equal(claudeActivity({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'src/app.js'}}]}}),'Read: src/app.js');
  assert.equal(claudeActivity({type:'user'}),null);
});
test('hands off only after approval and carries previous output',async()=>{
  const calls=[],events=[];
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:args=>{calls.push(args);return {promise:Promise.resolve('Stage answer '+calls.length),cancel(){}};}});
  runner.start(definition,'Implement a project picker','test-project');await tick();
  assert.equal(calls.length,1);assert.equal(statuses(events).at(-1).state,'waiting');
  assert.throws(()=>runner.start(definition,'another','test'));
  runner.resume({note:'Prefer a dropdown'});await tick();
  assert.equal(calls[1].step.kind,'claude');assert.match(calls[1].prompt,/Stage answer 1/);assert.match(calls[1].prompt,/Prefer a dropdown/);
  const done=statuses(events).at(-1);assert.equal(done.state,'done');assert.equal(done.outputs.length,2);
  runner.start(definition,'A second run is allowed after completion','cwd');await tick();assert.equal(calls.length,3);
});
test('an edited handoff replaces the previous answer',async()=>{
  const calls=[];const runner=new PipelineRunner({emit:()=>{},execute:args=>{calls.push(args);return {promise:Promise.resolve('original plan'),cancel(){}};}});
  runner.start(definition,'x','cwd');await tick();
  runner.resume({editedOutput:'my corrected plan'});await tick();
  assert.match(calls[1].prompt,/my corrected plan/);assert.doesNotMatch(calls[1].prompt,/original plan/);
  assert.equal(runner.run.outputs[0].edited,true);
});
test('auto-approve runs every stage without stopping',async()=>{
  const events=[];let n=0;
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:()=>({promise:Promise.resolve('answer '+(++n)),cancel(){}})});
  runner.start(definition,'x','cwd',{autoApprove:true});await tick();await tick();
  assert.equal(statuses(events).some(e=>e.state==='waiting'),false);assert.equal(statuses(events).at(-1).state,'done');
});
test('cancellation kills active work and ignores a late completion',async()=>{
  let resolve,cancelled=false;const events=[];
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:()=>({promise:new Promise(r=>resolve=r),cancel:()=>cancelled=true})});
  runner.start(definition,'test','cwd');runner.cancel();resolve('late answer');await tick();await tick();
  assert.equal(cancelled,true);assert.equal(statuses(events).at(-1).state,'cancelled');assert.equal(runner.active,false);
  runner.dismiss();assert.equal(runner.run,null);
});
test('a failed stage can be retried',async()=>{
  const events=[];let attempts=0;
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:()=>({promise:++attempts===1?Promise.reject(Error('CLI authentication required')):Promise.resolve('worked'),cancel(){}})});
  runner.start({name:'One',steps:[definition.steps[0]]},'test','cwd');await tick();
  assert.equal(statuses(events).at(-1).state,'error');assert.match(statuses(events).at(-1).text,/authentication/);assert.equal(runner.active,false);
  runner.retry();await tick();
  assert.equal(statuses(events).at(-1).state,'done');assert.equal(statuses(events).at(-1).outputs[0].text,'worked');
});
test('redo at a handoff reruns the stage that just finished',async()=>{
  const calls=[];const runner=new PipelineRunner({emit:()=>{},execute:args=>{calls.push(args);return {promise:Promise.resolve('take '+calls.length),cancel(){}};}});
  runner.start(definition,'x','cwd');await tick();
  runner.retry({note:'More detail please'});await tick();
  assert.equal(calls[1].step.role,'Plan');assert.match(calls[1].prompt,/More detail please/);
  assert.equal(runner.run.outputs.length,1);assert.equal(runner.run.outputs[0].text,'take 2');
});
test('codex json events become readable activity lines',()=>{
  const {codexActivity}=require('../lib/pipeline-runner');
  assert.equal(codexActivity({type:'item.started',item:{type:'command_execution',command:`"C:\pwsh.exe" -Command 'npm test'`}}),'Running: npm test');
  assert.equal(codexActivity({type:'item.completed',item:{type:'file_change',changes:[{path:'a.js',kind:'add'}]}}),'Created a.js');
  assert.equal(codexActivity({type:'turn.started'}),null);
});
test('stages record the model the CLI reports, and effort reaches the CLI flags',async()=>{
  const runner=new PipelineRunner({emit:()=>{},execute:()=>({promise:Promise.resolve({text:'ok',model:'claude-opus-5-5'}),cancel(){}})});
  runner.start({name:'M',steps:[{kind:'claude',role:'Plan',model:'claude-opus-5-5',effort:'high'}]},'x','cwd');await tick();
  assert.equal(runner.run.outputs[0].ranOn,'claude-opus-5-5');assert.equal(runner.run.outputs[0].effort,'high');
  const {codexSessionModel}=require('../lib/pipeline-runner');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'vd-home-'));const d=new Date();
  const dir=path.join(home,'.codex','sessions',String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rollout-x-0123456789abcdef.jsonl'),'{"type":"turn_context","payload":{"model":"gpt-6-sol"}}\n');
  assert.equal(codexSessionModel('0123456789abcdef',home),'gpt-6-sol');assert.equal(codexSessionModel('missing-thread-id',home),'');
  fs.rmSync(home,{recursive:true,force:true});
});
