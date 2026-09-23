const {test}=require('node:test');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {executeStage}=require('../lib/pipeline-runner');
test('runs CLI adapter, safely passes stdin and collects final output',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck adapter '));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=path.join(dir,'fake-cli.js');
  fs.writeFileSync(script,`#!/usr/bin/env node\nlet text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const args=process.argv;const g=args.indexOf('--prompt-file');if(g>=0){console.log(require('fs').readFileSync(args[g+1],'utf8'));return;}const i=args.indexOf('-o');if(i>=0)require('fs').writeFileSync(args[i+1],text);else console.log(JSON.stringify({result:text,is_error:false}));});`);
  let command=script;
  if(process.platform==='win32'){command=path.join(dir,'fake-cli.cmd');fs.writeFileSync(command,`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);}else fs.chmodSync(script,0o755);
  for(const kind of ['codex','claude','grok']){
    const prompt='Quotes " stay literal; & no shell $(commands)\nsecond line';
    const result=await executeStage({step:{kind,role:'Plan',model:'test-model'},prompt,cwd:dir,resolveCommand:()=>command}).promise;
    assert.equal(result,prompt);
  }
});
