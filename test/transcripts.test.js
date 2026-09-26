const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readAnswer}=require('../lib/transcripts');

// Sample logs shaped like the real Claude Code 2.1, Codex 0.157 and Grok 1.0 session files.
function fakeHome(t){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'vd-logs-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  return home;
}
const cwd=path.resolve(os.tmpdir(),'my project');
const iso=ms=>new Date(ms).toISOString();
const jsonl=rows=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const PROMPT='What is 17 times 3? Reply with just the number.';

test('claude: exact answer text, finish flag and model come from the session log',t=>{
  const home=fakeHome(t),now=Date.now();
  const dir=path.join(home,'.claude','projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'s1.jsonl');
  fs.writeFileSync(file,jsonl([
    {type:'user',timestamp:iso(now-60000),message:{role:'user',content:PROMPT}},
    {type:'assistant',timestamp:iso(now-59000),message:{model:'claude-opus-5-5',stop_reason:'end_turn',content:[{type:'text',text:'50'}]}},
    {type:'user',timestamp:iso(now),message:{role:'user',content:PROMPT}},
    {type:'assistant',timestamp:iso(now+500),message:{model:'claude-opus-5-5',stop_reason:'tool_use',content:[{type:'text',text:'Let me check.'},{type:'tool_use',name:'Bash',input:{}}]}},
    {type:'user',timestamp:iso(now+900),message:{role:'user',content:[{type:'tool_result',content:'51'}]}},
  ]));
  let r=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,home});
  assert.equal(r.done,false,'still working: last message asked for a tool');assert.equal(r.text,'Let me check.');
  fs.appendFileSync(file,jsonl([{type:'assistant',timestamp:iso(now+1500),message:{model:'claude-sonnet-5',stop_reason:'end_turn',content:[{type:'thinking',thinking:'x'},{type:'text',text:'51'}]}}]));
  r=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,home});
  assert.equal(r.done,true);assert.equal(r.text,'Let me check.\n\n51');assert.equal(r.model,'claude-sonnet-5');
  // an earlier ask of the same prompt is never mistaken for this round
  assert.equal(readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now+60000,home}),null);
});

test('codex: matches the project folder and reads the task_complete answer',t=>{
  const home=fakeHome(t),now=Date.now(),d=new Date();
  const dir=path.join(home,'.codex','sessions',String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  const rows=folder=>[
    {timestamp:iso(now),type:'session_meta',payload:{cwd:folder}},
    {timestamp:iso(now),type:'turn_context',payload:{model:'gpt-6-sol'}},
    {timestamp:iso(now),type:'response_item',payload:{type:'message',role:'user',content:[{text:'<environment_context>x</environment_context>'}]}},
    {timestamp:iso(now+100),type:'response_item',payload:{type:'message',role:'user',content:[{text:PROMPT}]}},
    {timestamp:iso(now+900),type:'response_item',payload:{type:'message',role:'assistant',content:[{text:'51'}]}},
    {timestamp:iso(now+950),type:'event_msg',payload:{type:'task_complete',last_agent_message:'51'}},
  ];
  fs.writeFileSync(path.join(dir,'rollout-other.jsonl'),jsonl(rows(path.resolve(os.tmpdir(),'somewhere else'))));
  fs.writeFileSync(path.join(dir,'rollout-mine.jsonl'),jsonl(rows(cwd)));
  const r=readAnswer({kind:'codex',cwd,prompt:PROMPT,sinceTs:now,home});
  assert.equal(r.text,'51');assert.equal(r.done,true);assert.equal(r.model,'gpt-6-sol');assert.match(r.file,/rollout-mine/);
});

test('grok: reads <user_query> prompts and waits until no tool calls remain',t=>{
  const home=fakeHome(t);
  const dir=path.join(home,'.grok','sessions',encodeURIComponent(cwd),'sess1');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'chat_history.jsonl');
  fs.writeFileSync(file,jsonl([
    {type:'user',content:[{type:'text',text:'<user_info>x</user_info>'}]},
    {type:'user',content:[{type:'text',text:'<system-reminder>skills</system-reminder>'}],synthetic_reason:'x'},
    {type:'user',content:[{type:'text',text:`<user_query>\n${PROMPT}\n</user_query>`}],prompt_index:0},
    {type:'assistant',content:'',tool_calls:[{name:'read_file'}],model_id:'grok-4.7-build'},
    {type:'tool_result',content:'x'},
  ]));
  let r=readAnswer({kind:'grok',cwd,prompt:PROMPT,sinceTs:Date.now()-10000,home});
  assert.equal(r.done,false);
  fs.appendFileSync(file,jsonl([{type:'assistant',content:'51',model_id:'grok-4.7-build'}]));
  r=readAnswer({kind:'grok',cwd,prompt:PROMPT,sinceTs:Date.now()-10000,home});
  assert.equal(r.text,'51');assert.equal(r.done,true);assert.equal(r.model,'grok-4.7-build');
});

test('two panes of the same CLI get their own session logs',t=>{
  const home=fakeHome(t),now=Date.now();
  const dir=path.join(home,'.claude','projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(dir,{recursive:true});
  for(const [name,answer] of [['a.jsonl','first'],['b.jsonl','second']])fs.writeFileSync(path.join(dir,name),jsonl([
    {type:'user',timestamp:iso(now),message:{content:PROMPT}},
    {type:'assistant',timestamp:iso(now+10),message:{stop_reason:'end_turn',content:[{type:'text',text:answer}]}}]));
  const one=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,home});
  const two=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,home,exclude:[one.file]});
  assert.notEqual(one.file,two.file);assert.notEqual(one.text,two.text);
  assert.equal(readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,home,prefer:two.file}).text,two.text);
});

test('turns that end without a clean finish still count as done',t=>{
  const home=fakeHome(t),now=Date.now();
  const {logPathFor}=require('../lib/transcripts');
  const sid='11111111-2222-3333-4444-555555555555';
  const file=logPathFor('claude',cwd,sid,home);fs.mkdirSync(path.dirname(file),{recursive:true});
  // Esc pressed mid-answer
  fs.writeFileSync(file,jsonl([
    {type:'user',timestamp:iso(now),message:{content:PROMPT}},
    {type:'assistant',timestamp:iso(now+10),message:{stop_reason:null,content:[{type:'text',text:'Working on'}]}},
    {type:'user',timestamp:iso(now+20),message:{content:[{type:'text',text:'[Request interrupted by user]'}]}}]));
  let r=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,file,home});
  assert.equal(r.done,true);assert.equal(r.text,'Working on');
  // rate limit / API error arrives as a <synthetic> message
  fs.writeFileSync(file,jsonl([
    {type:'user',timestamp:iso(now),message:{content:PROMPT}},
    {type:'assistant',timestamp:iso(now+10),message:{model:'<synthetic>',stop_reason:'stop_sequence',content:[{type:'text',text:'API Error: rate limited'}]}}]));
  r=readAnswer({kind:'claude',cwd,prompt:PROMPT,sinceTs:now,file,home});
  assert.equal(r.done,true);assert.match(r.text,/rate limited/);
  // reading by the pane's own session file ignores other sessions in the same folder
  fs.writeFileSync(path.join(path.dirname(file),'someone-else.jsonl'),jsonl([
    {type:'user',timestamp:iso(now+500),message:{content:'another prompt'}},
    {type:'assistant',timestamp:iso(now+600),message:{stop_reason:'end_turn',content:[{type:'text',text:'not yours'}]}}]));
  assert.match(readAnswer({kind:'claude',cwd,prompt:'',file,home}).text,/rate limited/);
});

test('codex: an aborted turn is done',t=>{
  const home=fakeHome(t),now=Date.now(),d=new Date();
  const dir=path.join(home,'.codex','sessions',String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'rollout-a.jsonl'),jsonl([
    {timestamp:iso(now),type:'session_meta',payload:{cwd}},
    {timestamp:iso(now+100),type:'response_item',payload:{type:'message',role:'user',content:[{text:PROMPT}]}},
    {timestamp:iso(now+200),type:'event_msg',payload:{type:'turn_aborted'}}]));
  const r=readAnswer({kind:'codex',cwd,prompt:PROMPT,sinceTs:now,home});
  assert.equal(r.done,true);
});

test('a log whose modified time never changes (Codex keeps it open on Windows) is still found as it grows',t=>{
  const {primeLogs}=require('../lib/transcripts');
  const home=fakeHome(t),now=Date.now(),d=new Date();
  const dir=path.join(home,'.codex','sessions',String(d.getFullYear()),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0'));fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'rollout-open.jsonl');
  fs.writeFileSync(file,jsonl([{timestamp:iso(now-600000),type:'session_meta',payload:{cwd}}]));
  const frozen=new Date(now-600000);fs.utimesSync(file,frozen,frozen);
  primeLogs('codex',cwd,home); // round starts: sizes recorded
  fs.appendFileSync(file,jsonl([
    {timestamp:iso(now+100),type:'turn_context',payload:{model:'gpt-6-sol'}},
    {timestamp:iso(now+200),type:'response_item',payload:{type:'message',role:'user',content:[{text:PROMPT}]}},
    {timestamp:iso(now+900),type:'response_item',payload:{type:'message',role:'assistant',content:[{text:'51'}]}},
    {timestamp:iso(now+950),type:'event_msg',payload:{type:'task_complete',last_agent_message:'51'}}]));
  fs.utimesSync(file,frozen,frozen); // Windows leaves the modified time alone
  const r=readAnswer({kind:'codex',cwd,prompt:PROMPT,sinceTs:now,home});
  assert.ok(r,'found despite the frozen modified time');assert.equal(r.text,'51');assert.equal(r.model,'gpt-6-sol');
});
