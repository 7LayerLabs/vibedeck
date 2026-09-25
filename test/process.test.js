const {test}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {executeStage}=require('../lib/pipeline-runner');
test('runs CLI adapter, safely passes stdin and collects final output',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck adapter '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=path.join(dir,'fake-cli.js');
  fs.writeFileSync(script,`#!/usr/bin/env node\nlet text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const args=process.argv;const g=args.indexOf('--prompt-file');if(g>=0){console.log(JSON.stringify({type:'result',result:require('fs').readFileSync(args[g+1],'utf8'),is_error:false}));return;}const i=args.indexOf('-o');if(i>=0)require('fs').writeFileSync(args[i+1],text);else {console.log(JSON.stringify({type:'system',subtype:'init',model:'test'}));console.log(JSON.stringify({type:'result',result:text,is_error:false}));}});`);
  let command=script;
  if(process.platform==='win32'){command=path.join(dir,'fake-cli.cmd');fs.writeFileSync(command,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);}else fs.chmodSync(script,0o755);
  for(const kind of ['codex','claude','grok']){
    const prompt='Quotes " stay literal; & no shell $(commands)\nsecond line';
    const activity=[];const result=await executeStage({step:{kind,role:'Plan',model:'test-model'},prompt,cwd:dir,resolveCommand:()=>command,onActivity:l=>activity.push(l)}).promise;
    if(kind==='claude')assert.deepEqual(activity,['Session started on test']);
    assert.equal(result,prompt);
  }
  fs.writeFileSync(script,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',result:'Completed with an allowed alternative.',is_error:false,permission_denials:[{tool_name:'Bash'}]})));`);
  const recovered=await executeStage({step:{kind:'claude',role:'Build'},prompt:'test',cwd:dir,resolveCommand:()=>command}).promise;
  assert.match(recovered,/Completed with an allowed alternative/);
  assert.match(recovered,/Permission note: 1 tool request/);
});
