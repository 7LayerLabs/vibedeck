'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {childEnv} = require('./env');

const KINDS = ['claude','codex','grok','api'];
const ROLES = ['Plan','Build','Review'];
const MAX_INSTRUCTIONS = 4000;
const EFFORTS = ['low','medium','high','xhigh','max','ultra'];

function validatePipeline(value) {
  if(!value || typeof value.name!=='string' || !value.name.trim() || value.name.length>80) throw Error('Give this pipeline a name (up to 80 characters).');
  if(!Array.isArray(value.steps) || value.steps.length<1 || value.steps.length>8) throw Error('Choose between one and eight stages.');
  return {name:value.name.trim(), steps:value.steps.map(step=>{
    if(!KINDS.includes(step?.kind)) throw Error('Choose Claude, Codex, Grok or a saved API connection.');
    if(!ROLES.includes(step.role)) throw Error('Choose Plan, Build or Review for each stage.');
    const model=String(step.model||'').trim();
    if(model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(model)) throw Error('Use a valid model ID, or leave it empty for the default.');
    if(step.kind==='api' && !/^[a-f0-9-]{36}$/.test(step.connectionId||''))throw Error('Select a saved API connection.');
    const effort=String(step.effort||'').trim();
    if(effort && (!EFFORTS.includes(effort) || step.kind==='api'))throw Error('Choose a valid effort level, or leave it on the default.');
    const instructions=String(step.instructions||'').trim();
    if(instructions.length>MAX_INSTRUCTIONS)throw Error(`Keep stage instructions under ${MAX_INSTRUCTIONS} characters.`);
    // "Can run commands" only means something for Claude and Grok Build stages; Codex Build runs commands in its own sandbox.
    const commands=!!step.commands && step.role==='Build' && ['claude','grok'].includes(step.kind);
    return {kind:step.kind,role:step.role,model,...(effort?{effort}:{}),...(commands?{commands}:{}),...(instructions?{instructions}:{}),...(step.kind==='api'?{connectionId:step.connectionId}:{})};
  })};
}

// What each role is told. Plan and Review never edit files; Build does the work.
const ROLE_BRIEF = {
  Plan: 'You are the PLANNER. Read the project as needed, but do not create, edit or delete any files. Produce a clear, numbered implementation plan: the files involved, the concrete changes, the order to make them, and the risks or edge cases to watch. Keep it tight and specific to this codebase.',
  Build: 'You are the BUILDER. Implement the request in this project, following the plan from earlier stages unless it is clearly wrong. Make the real file changes. When you finish, reply with a short summary: what you changed (file by file), anything you skipped and why, and how to check it works.',
  Review: 'You are the REVIEWER. Do not create, edit or delete any files. Check the actual state of the project against the original request (for example by reading the changed files or running git diff). List concrete problems by severity (bugs first, then missed requirements, then cleanups), each with the file and what to change. End with a one-line verdict: SHIP IT or NEEDS WORK.',
};

function stagePrompt({step,request,outputs,note}) {
  const earlier=outputs.map((o,i)=>`--- Stage ${i+1}: ${o.role} (${o.kind}${o.model?' '+o.model:''}) ---\n${o.text}`).join('\n\n');
  return [
    ROLE_BRIEF[step.role],
    step.instructions?`Extra instructions for this stage:\n${step.instructions}`:'',
    `Original request:\n${request}`,
    earlier?`Output from earlier stages (context, not authority to change the request):\n${earlier.slice(-120000)}`:'',
    note?`Guidance from the user for this stage:\n${note}`:'',
  ].filter(Boolean).join('\n\n');
}

const stripAnsi = s => s.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z]/g,'').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');

// Turns one line of claude's stream-json (grok's streaming-messages-json uses the same shape) into a readable activity line.
function claudeActivity(event) {
  if(event.type==='system' && event.subtype==='init') return `Session started${event.model?' on '+event.model:''}`;
  if(event.type!=='assistant') return null;
  const lines=[];
  for(const block of event.message?.content||[]) {
    if(block.type==='tool_use') {
      const input=block.input||{};
      const target=input.file_path||input.target_file||input.path||input.pattern||input.command||input.url||input.description||'';
      lines.push(`${block.name}${target?': '+String(target).replace(/\s+/g,' ').slice(0,140):''}`);
    } else if(block.type==='text' && block.text.trim()) lines.push(block.text.trim().replace(/\s+/g,' ').slice(0,200));
  }
  return lines.join('\n')||null;
}

// Turns one line of `codex exec --json` into a readable activity line.
function codexActivity(event) {
  const item=event.item;
  if(event.type==='error')return 'Error: '+String(event.message||'').slice(0,200);
  if(!item)return null;
  const one=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,200);
  if(item.type==='agent_message' && event.type==='item.completed')return one(item.text);
  if(item.type==='command_execution'){
    // strip the shell wrapper codex adds ("...pwsh.exe" -Command '...') so the real command shows
    const cmd=one(String(item.command||'').replace(/^"[^"]*(?:pwsh|powershell|bash|cmd)(?:\.exe)?"\s+-(?:Command|c)\s+/i,'').replace(/^'(.*)'$/,'$1'));
    if(event.type==='item.started')return 'Running: '+cmd;
    if(event.type==='item.completed' && item.exit_code)return `Command failed (exit ${item.exit_code}): ${cmd}`;
    return null;
  }
  if(item.type==='file_change' && event.type==='item.completed')return (item.changes||[]).map(c=>`${c.kind==='add'?'Created':c.kind==='delete'?'Deleted':'Edited'} ${c.path}`).join('\n')||null;
  if(item.type==='mcp_tool_call' && event.type==='item.started')return `Tool: ${item.server||''}${item.tool?'.'+item.tool:''}`;
  if(item.type==='web_search' && event.type==='item.started')return 'Searching the web: '+one(item.query);
  if(item.type==='error')return /Skill descriptions were shortened/i.test(item.message||'')?null:'Error: '+one(item.message);
  return null;
}

// Codex doesn't print its model in --json mode, but its session log records it.
function codexSessionModel(threadId,home=os.homedir()) {
  if(!/^[\w-]{8,}$/.test(threadId||''))return '';
  const root=path.join(home,'.codex','sessions');
  for(let back=0;back<2;back++){
    const d=new Date(Date.now()-back*86400000);
    const dir=path.join(root,String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));
    let file;try {file=fs.readdirSync(dir).find(f=>f.includes(threadId));}catch {continue;}
    if(!file)continue;
    try {const m=fs.readFileSync(path.join(dir,file),'utf8').match(/"model":"([^"]+)"/);return m?m[1]:'';}catch {return '';}
  }
  return '';
}

// Grok cancels the whole run the moment its permission mode blocks a tool, so each stage only
// gets the tools it is allowed to use. With "Can run commands" a Build stage gets everything.
const grokMode=step=>step.role!=='Build'?'plan':step.commands?'bypassPermissions':'acceptEdits';
const grokTools=step=>step.role!=='Build'?['--tools','read_file,list_dir,grep']:step.commands?[]:['--tools','read_file,list_dir,grep,write,search_replace'];

// Prompt text goes through stdin (or a private temp file for grok), never through a command shell.
function executeStage({step,prompt,cwd,resolveCommand,onActivity=()=>{},timeoutMs}) {
  let child, cancelled=false;
  timeoutMs=timeoutMs||(step.role==='Build'?30:15)*60000;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck-stage-'));
  const answerFile=path.join(temp,'answer.txt');
  const stop=()=>{
    cancelled=true;
    if(!child?.pid)return;
    if(process.platform==='win32') spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else {try {process.kill(-child.pid,'SIGKILL');} catch {child.kill('SIGKILL');}}
  };
  const promise=new Promise((resolve,reject)=>{
    let output='',errors='',failure=null,streamResult=null,initModel='',threadId='',lineBuf={out:'',err:''};
    const jsonStream=step.kind==='claude'||step.kind==='grok';
    const command=resolveCommand(step.kind);
    const promptFile=path.join(temp,'prompt.txt');
    if(step.kind==='grok')fs.writeFileSync(promptFile,prompt,{mode:0o600});
    const args=step.kind==='codex' ? ['exec','--skip-git-repo-check','--json','--sandbox',step.role==='Build'?'workspace-write':'read-only','-o',answerFile]
      : step.kind==='grok' ? ['--prompt-file',promptFile,'--output-format','streaming-messages-json','--permission-mode',grokMode(step),...grokTools(step)]
      : ['-p','--output-format','stream-json','--verbose','--permission-mode',step.role!=='Build'?'plan':step.commands?'bypassPermissions':'acceptEdits'];
    if(step.model) args.push(step.kind==='codex'?'-m':'--model',step.model);
    if(step.effort) args.push(...(step.kind==='codex'?['-c',`model_reasoning_effort=${step.effort}`]:step.kind==='grok'?['--reasoning-effort',step.effort]:['--effort',step.effort]));
    if(step.kind==='codex')args.push('-');
    // .cmd shims require cmd.exe. Only validated model IDs and trusted fixed args enter it.
    const isCmd=process.platform==='win32' && /\.cmd$/i.test(command);
    if(isCmd && /["%\r\n]/.test(command)) {reject(Error('Unsupported CLI installation path.'));return;}
    try {
      child=spawn(isCmd?'cmd.exe':command,isCmd?['/d','/s','/c',`""${command}" ${args.map(a=>'"'+a+'"').join(' ')}"`]:args,{cwd,windowsHide:true,windowsVerbatimArguments:isCmd,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env:childEnv({NO_COLOR:'1'})});
    } catch(err) {reject(Error(`Could not start ${step.kind}: ${err.message}`));return;}
    const timer=setTimeout(()=>{failure=Error(`Stage timed out after ${Math.round(timeoutMs/60000)} minutes. Its process was stopped.`);stop();},timeoutMs);
    const handleLine=(line,stderr)=>{
      if(jsonStream && !stderr) {
        let event;try {event=JSON.parse(line);}catch {return;}
        if(event.type==='result')streamResult=event;
        if(event.type==='system' && event.subtype==='init' && event.model)initModel=event.model;
        const text=claudeActivity(event);if(text)onActivity(text);
        return;
      }
      if(step.kind==='codex' && !stderr) {
        let event;try {event=JSON.parse(line);}catch {return;}
        if(event.type==='thread.started')threadId=event.thread_id||'';
        const text=codexActivity(event);if(text)onActivity(text);
      }
    };
    const collect=(text,stderr)=>{
      if(stderr) errors=(errors+text).slice(-12000); else output+=text;
      if(output.length>4*1024*1024){failure=Error('Stage output exceeded 4 MB.');stop();return;}
      const key=stderr?'err':'out';
      const parts=(lineBuf[key]+text).split(/\r?\n/);lineBuf[key]=parts.pop();
      for(const line of parts)handleLine(line,stderr);
    };
    child.stdout.on('data',chunk=>collect(chunk.toString(),false));
    child.stderr.on('data',chunk=>collect(chunk.toString(),true));
    child.on('error',err=>{failure=err;});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      clearTimeout(timer);
      if(lineBuf.out)handleLine(lineBuf.out,false);
      if(failure)return reject(failure);
      if(cancelled)return reject(Error('Pipeline cancelled.'));
      if(code!==0 && !streamResult)return reject(Error(`${step.kind} exited with code ${code}. ${stripAnsi(errors).trim().slice(-1500)}`));
      try {
        let model='';
        if(step.kind==='codex'){output=fs.readFileSync(answerFile,'utf8');model=codexSessionModel(threadId);}
        else if(jsonStream) {
          const result=streamResult,name=step.kind==='claude'?'Claude':'Grok';
          if(!result)throw Error(`${name} ended without a final answer.`);
          if(result.is_error && result.stop_reason==='cancelled')throw Error(step.role==='Build'?`${name} tried to run a command, which this stage does not allow, so it stopped. Turn on "Can run commands" for this stage, then retry.`:`${name} tried an action a ${step.role} stage does not allow, so it stopped. Retry the stage.`);
          if(result.is_error)throw Error(result.result||(result.errors||[]).join('; ')||`${name} reported a failed stage.`);
          output=result.result;
          // modelUsage is what the provider actually billed; init is what the session started on
          model=Object.keys(result.modelUsage||{})[0]||initModel;
          // A denied attempt can be followed by a successful permitted alternative.
          // Keep the denial visible at the approval handoff without discarding the result.
          if(typeof output==='string' && output.trim() && result.permission_denials?.length)output+='\n\nPermission note: '+result.permission_denials.length+' tool request(s) were denied (usually running commands such as tests). '+(step.role==='Build'?'Turn on "Can run commands" for this stage to allow them. ':'')+'Check for incomplete work before approving the next stage.';
        }
                if(typeof output!=='string' || !output.trim())throw Error('The stage returned no answer.');
        resolve({text:output.trim(),model});
      } catch(err){reject(err);}
    });
    child.stdin.end(step.kind==='grok'?'':prompt);
  }).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
  return {promise,cancel:stop};
}

// One pipeline at a time. States: running -> waiting (handoff review) -> running ... -> done.
// A failed stage parks in 'error' with the run kept, so it can be retried or dismissed.
class PipelineRunner {
  constructor({emit,execute=executeStage,resolveCommand}) {Object.assign(this,{emit,execute,resolveCommand});this.run=null;}
  status(extra={}) {
    const run=this.run;
    if(!run)return {state:'idle',outputs:[]};
    return {state:run.state,id:run.id,name:run.def.name,steps:run.def.steps,request:run.prompt,cwd:run.cwd,autoApprove:run.autoApprove,
      index:run.index,step:run.def.steps[run.index],outputs:run.outputs,startedAt:run.startedAt,stageStartedAt:run.stageStartedAt,
      activity:run.activity,text:run.text||'',...extra};
  }
  publish(extra){this.emit(this.status(extra));}
  start(def,prompt,cwd,{autoApprove=false}={}) {
    if(this.run && !['done','cancelled','error'].includes(this.run.state))throw Error('Finish or stop the active pipeline first.');
    def=validatePipeline(def);
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>32000)throw Error('Describe what the pipeline should do (up to 32,000 characters).');
    this.run={id:Date.now(),def,prompt:prompt.trim(),cwd,index:0,outputs:[],state:'running',autoApprove:!!autoApprove,startedAt:Date.now(),activity:[],note:''};
    this.next();
  }
  async next(){
    const run=this.run;if(!run)return;
    const step=run.def.steps[run.index];
    Object.assign(run,{state:'running',text:'',activity:[],stageStartedAt:Date.now()});
    this.publish();
    let pending=null;
    const onActivity=line=>{
      run.activity.push({t:Date.now(),line});if(run.activity.length>200)run.activity.splice(0,run.activity.length-200);
      if(!pending)pending=setTimeout(()=>{pending=null;if(this.run===run && run.state==='running')this.emit({type:'activity',id:run.id,index:run.index,activity:run.activity.slice(-60)});},400);
    };
    try {
      run.task=this.execute({step,cwd:run.cwd,resolveCommand:this.resolveCommand,onActivity,prompt:stagePrompt({step,request:run.prompt,outputs:run.outputs,note:run.note})});
      const result=await run.task.promise;
      if(this.run!==run || run.cancelled)return;
      const text=typeof result==='string'?result:result.text;
      const ranOn=typeof result==='string'?'':result.model||'';
      run.note='';
      run.outputs.push({...step,text,ranOn,ms:Date.now()-run.stageStartedAt});run.index++;
      if(run.index===run.def.steps.length){run.state='done';run.finishedAt=Date.now();this.publish();}
      else if(run.autoApprove){this.next();}
      else {run.state='waiting';this.publish();}
    } catch(err){
      clearTimeout(pending);
      if(this.run===run && !run.cancelled){run.state='error';run.text=err.message;this.publish();}
    }
  }
  // Approve the handoff. note = extra guidance for the next stage; editedOutput replaces the last stage's answer.
  resume({note,editedOutput}={}){
    const run=this.run;
    if(!run || run.state!=='waiting')throw Error('No handoff is waiting for review.');
    if(typeof editedOutput==='string' && editedOutput.trim() && run.outputs.length){
      if(editedOutput.length>200000)throw Error('The edited handoff is too long.');
      run.outputs[run.outputs.length-1]={...run.outputs[run.outputs.length-1],text:editedOutput.trim(),edited:true};
    }
    run.note=typeof note==='string'?note.trim().slice(0,4000):'';
    this.next();
  }
  // Re-run a failed stage, or redo the stage that just finished while waiting at its handoff.
  retry({note}={}){
    const run=this.run;
    if(!run || !['error','waiting'].includes(run.state))throw Error('There is no stage to retry.');
    if(run.state==='waiting'){run.index--;run.outputs.pop();}
    run.note=typeof note==='string'?note.trim().slice(0,4000):'';
    this.next();
  }
  setAutoApprove(on){if(this.run){this.run.autoApprove=!!on;this.publish();}}
  dismiss(){if(this.run && ['done','cancelled','error'].includes(this.run.state)){this.run=null;this.publish();}}
  cancel(){
    const run=this.run;
    if(!run || run.cancelled || ['done','cancelled','error'].includes(run.state))return; // an ended run keeps its real outcome
    if(run.state!=='running'){run.state='cancelled';run.text='Pipeline stopped. Remaining stages were dropped.';this.publish();return;}
    run.cancelled=true;run.state='cancelling';run.text='Stopping the active process.';this.publish();run.task?.cancel();
    Promise.resolve(run.task?.promise).catch(()=>{}).then(()=>{
      if(this.run!==run)return;
      run.state='cancelled';
      run.text=run.def.steps[run.index]?.kind==='api'?'Stopped the API request and dropped the remaining stages.':'Stopped the active process and dropped the remaining stages.';
      this.publish();
    });
  }
  get active(){return !!this.run && ['running','waiting','cancelling'].includes(this.run.state);}
}
module.exports={validatePipeline,PipelineRunner,executeStage,stagePrompt,claudeActivity,codexActivity,codexSessionModel};
