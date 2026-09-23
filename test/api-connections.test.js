const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {Connections,validateConnection,executeApiStage}=require('../lib/api-connections');
test('validates endpoints without silently sending keys over remote HTTP',()=>{
  const base={name:'Open model',protocol:'openai',model:'vendor/model:latest'};
  assert.equal(validateConnection({...base,baseUrl:'http://localhost:11434/v1'}).local,true);
  for(const baseUrl of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?key=x','file:///tmp'])assert.throws(()=>validateConnection({...base,baseUrl}));
});
test('keeps API keys out of connection metadata and refuses key reuse at a changed destination',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck-keys-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const stored=new Map();const vault=async(action,id,key)=>{if(action==='get')return stored.get(id)||'';if(action==='delete')stored.delete(id);else stored.set(id,key);};
  const file=path.join(dir,'connections.json');const connections=new Connections(file,vault);
  const input={name:'API',protocol:'openai',baseUrl:'https://provider.example/v1',model:'vendor/model',apiKey:'test-secret',remember:true};
  const record=await connections.save(input);
  assert.equal(JSON.stringify(connections.list()).includes('test-secret'),false);assert.equal(fs.readFileSync(file,'utf8').includes('test-secret'),false);
  assert.equal((await new Connections(file,vault).get(record.id)).apiKey,'test-secret');
  await assert.rejects(()=>connections.save({...input,id:record.id,baseUrl:'https://different.example/v1',apiKey:''}),/Enter an API key/);
  await connections.save({...input,id:record.id,remember:false});assert.equal(stored.has(record.id),false);
  await connections.remove(record.id);assert.deepEqual(connections.list(),[]);
});
test('OpenAI-compatible and Anthropic stages send the right protocol and return final text',async t=>{
  const requests=[];const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({url:req.url,headers:req.headers,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/messages')?{content:[{type:'text',text:'Anthropic answer'}],stop_reason:'end_turn'}:{choices:[{message:{content:'Open answer'},finish_reason:'stop'}]}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  for(const protocol of ['openai','anthropic']){
    const connections={get:async()=>({name:'Test',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol,model:'test-model',apiKey:'fixture-key'})};
    const answer=await executeApiStage({step:{connectionId:'fixture',model:''},prompt:'Review the supplied text.',connections}).promise;
    assert.equal(answer,protocol==='openai'?'Open answer':'Anthropic answer');
  }
  assert.equal(requests[0].headers.authorization,'Bearer fixture-key');assert.equal(requests[1].headers['x-api-key'],'fixture-key');assert.match(requests[0].body.messages[0].content,/no filesystem/);
});
test('rejects incomplete answers, masks provider error bodies, and cancels requests',async()=>{
  const connections={get:async()=>({name:'Test',baseUrl:'https://provider.example/v1',protocol:'openai',model:'test',apiKey:'secret'})};
  const step={connectionId:'fixture'};
  await assert.rejects(executeApiStage({step,prompt:'test',connections,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'partial'},finish_reason:'length'}]}))}).promise,/incomplete/);
  await assert.rejects(executeApiStage({step,prompt:'test',connections,fetchImpl:async()=>new Response('secret error',{status:401})}).promise,error=>error.message.includes('401')&&!error.message.includes('secret'));
  const run=executeApiStage({step,prompt:'test',connections,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('aborted'));else signal.addEventListener('abort',()=>reject(Error('aborted')));})});
  run.cancel();await assert.rejects(run.promise,/cancelled/);
});
