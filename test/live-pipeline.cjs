// Manual opt-in integration check: consumes the signed-in providers' usage.
// Run with node test/live-pipeline.cjs. All work is in a disposable temp project.
const {PipelineRunner}=require('../lib/pipeline-runner');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck-live-'));
const runner=new PipelineRunner({
  resolveCommand:kind=>process.platform==='win32'?(kind==='grok'?path.join(os.homedir(),'.grok/bin/grok.exe'):path.join(process.env.APPDATA,'npm',kind+'.cmd')):kind,
  emit:status=>{
    console.log(status.state, status.index??'', status.text||'');
    // This test explicitly approves only its own known, disposable task.
    if(status.state==='waiting')runner.resume();
    if(['done','error','cancelled'].includes(status.state)){
      try {
        assert.equal(status.state,'done');
        assert.equal(fs.readFileSync(path.join(cwd,'hello.txt'),'utf8'),'VIBEDECK_HANDOFF_OK');
        assert.match(status.outputs[2].text,/VIBEDECK_HANDOFF_OK/);
        console.log('PASS: Codex planned, Claude wrote the file, Grok reviewed it.');
      } catch(error){console.error(error.message);process.exitCode=1;}
      finally {fs.rmSync(cwd,{recursive:true,force:true});}
    }
  }
});
runner.start({name:'Live provider handoff',steps:[{kind:'codex',role:'Plan',model:''},{kind:'claude',role:'Build',model:''},{kind:'grok',role:'Review',model:''}]},'Plan: briefly specify a file hello.txt containing exactly VIBEDECK_HANDOFF_OK. Build: create only that file in the current directory, without a newline or BOM. Review: read hello.txt and report whether it contains exactly VIBEDECK_HANDOFF_OK, including the marker in your answer. Do not modify anything else. Keep each answer under 40 words.',cwd);
