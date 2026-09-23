const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {WebSocket}=require('ws');
test('local server authenticates HTTP and WebSockets; persists custom pipelines',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck-test-'));
  const child=fork(path.join(__dirname,'../server.js'),[],{env:{...process.env,VIBEDECK_PORT:'0',VIBEDECK_DATA_DIR:dir,VIBEDECK_NO_PANES:'1'},stdio:['ignore','ignore','pipe','ipc']});
  let socket;
  t.after(async()=>{socket?.terminate();child.send({type:'shutdown'});await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
  const url=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('server start timed out')),10000);child.once('message',m=>{clearTimeout(timeout);resolve(m.url);});child.once('error',reject);});
  const origin=new URL(url).origin;
  assert.equal((await fetch(origin)).status,403);
  const login=await fetch(url,{redirect:'manual'});assert.equal(login.status,302);
  const cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await fetch(origin,{headers:{cookie}})).status,200);
  assert.equal((await fetch(origin,{headers:{cookie,origin:'https://attacker.example'}})).status,403);
  const rejection=await new Promise(resolve=>{const bad=new WebSocket(origin.replace('http:','ws:'),{headers:{cookie,origin:'https://attacker.example'}});bad.on('unexpected-response',(_req,res)=>{resolve(res.statusCode);res.resume();bad.terminate();});bad.on('error',()=>{});});assert.equal(rejection,401);
  socket=new WebSocket(origin.replace('http:','ws:'),{headers:{cookie,origin}});
  const init=await new Promise(resolve=>socket.once('message',m=>resolve(JSON.parse(m))));assert.equal(init.type,'init');
  const saved=new Promise(resolve=>socket.once('message',m=>resolve(JSON.parse(m))));
  socket.send(JSON.stringify({type:'customPipelineSave',definition:{name:'Test chain',steps:[{role:'Plan',kind:'codex',model:'gpt-6-astra'}]}}));
  assert.equal((await saved).items[0].name,'Test chain');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'data/custom-pipelines.json')))[0].name,'Test chain');
});

