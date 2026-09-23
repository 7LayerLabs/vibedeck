// Run after packaging: node test/packaged-smoke.cjs
const {fork}=require('node:child_process');
const path=require('node:path');const fs=require('node:fs');const os=require('node:os');const assert=require('node:assert/strict');
const {WebSocket}=require('ws');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibedeck-packaged-'));
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({kinds:['shell'],cwd:dir,recents:[dir]}));
  const root=path.resolve('dist/win-unpacked');
  const child=fork(path.join(root,'resources/app.asar/server.js'),[],{execPath:path.join(root,'VibeDeck.exe'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',VIBEDECK_PORT:'0',VIBEDECK_DATA_DIR:dir,VIBEDECK_NO_PANES:''},stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let ws;
  const timeout=setTimeout(()=>{child.kill();process.exitCode=1;console.error('Packaged smoke timed out.');},25000);
  try {
    const url=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.url));child.once('error',reject);child.once('exit',code=>reject(Error('Packaged server exited '+code)));});
    const origin=new URL(url).origin;
    const login=await fetch(url,{redirect:'manual'});const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin+'/api/desktop-health',{headers:{cookie}})).status,200);
    ws=new WebSocket(origin.replace('http:','ws:'),{headers:{cookie,origin}});
    let pane,buffer='',sent=false;
    await new Promise((resolve,reject)=>{
      ws.on('error',reject);ws.on('message',raw=>{
        const msg=JSON.parse(raw);
        if(msg.type==='init'){pane=msg.panes[0]?.id;assert.ok(pane);}
        if(msg.type==='data'){
          buffer+=msg.data;
          if(!sent && /PS .*?>/.test(buffer)){sent=true;ws.send(JSON.stringify({type:'input',pane,data:"Write-Output ('VIBEDECK_' + 'PACKAGED_OK')\r"}));}
          if(buffer.includes('VIBEDECK_PACKAGED_OK'))resolve();
        }
        if(msg.type==='exit')reject(Error('Packaged terminal exited before responding.'));
      });
    });
    console.log('PASS: packaged Electron runtime, authenticated HTTP/WebSocket, native PTY, terminal command and writable profile.');
  } finally {clearTimeout(timeout);ws?.terminate();if(child.connected)child.send({type:'shutdown'});await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
