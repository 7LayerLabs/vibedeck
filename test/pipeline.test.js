const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PipelineRunner,validatePipeline}=require('../lib/pipeline-runner');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const definition={name:'Astra to Claude',steps:[{role:'Plan',kind:'codex',model:'gpt-6-astra'},{role:'Build',kind:'claude',model:''}]};
test('validates providers, models and stage counts',()=>{
  assert.equal(validatePipeline(definition).steps[0].model,'gpt-6-astra');
  for(const steps of [[],[{role:'Build',kind:'grok'}],[{role:'Build',kind:'codex',model:'x; whoami'}]])assert.throws(()=>validatePipeline({name:'Bad',steps}));
});
test('hands off only after approval and carries previous output',async()=>{
  const calls=[],events=[];
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:args=>{calls.push(args);return {promise:Promise.resolve('Stage answer '+calls.length),cancel(){}};}});
  runner.start(definition,'Implement a project picker','test-project');await tick();
  assert.equal(calls.length,1);assert.equal(events.at(-1).state,'waiting');
  assert.throws(()=>runner.start(definition,'another','test'));
  runner.resume();await tick();
  assert.equal(calls[1].step.kind,'claude');assert.match(calls[1].prompt,/Stage answer 1/);assert.equal(events.at(-1).state,'done');assert.equal(events.at(-1).outputs.length,2);
});
test('cancellation kills active work and ignores a late completion',async()=>{
  let resolve,cancelled=false;const events=[];
  const runner=new PipelineRunner({emit:e=>events.push(e),execute:()=>({promise:new Promise(r=>resolve=r),cancel:()=>cancelled=true})});
  runner.start(definition,'test','cwd');runner.cancel();resolve('late answer');await tick();
  assert.equal(cancelled,true);assert.equal(events.at(-1).state,'cancelled');assert.equal(runner.run,null);
});
test('failure stops subsequent stages',async()=>{
  const events=[];const runner=new PipelineRunner({emit:e=>events.push(e),execute:()=>({promise:Promise.reject(Error('CLI authentication required')),cancel(){}})});
  runner.start(definition,'test','cwd');await tick();assert.equal(events.at(-1).state,'error');assert.match(events.at(-1).text,/authentication/);assert.equal(runner.run,null);
});
