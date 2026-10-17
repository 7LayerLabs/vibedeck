const {app,BrowserWindow,dialog,session,safeStorage,shell} = require('electron');
const fs=require('node:fs');
const {fork,execFileSync} = require('node:child_process');
const path=require('node:path');
let backend,window,quitting=false;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.show();window?.focus();});
app.whenReady().then(()=>{
  if(process.platform==='darwin'){
    try {process.env.PATH=execFileSync(process.env.SHELL||'/bin/zsh',['-ilc','printf "%s" "$PATH"'],{encoding:'utf8',timeout:5000}).trim();} catch {}
  }
  // Only the clipboard is allowed: copy buttons, Ctrl+C, copy on select and right-click paste in the
  // app's own page (the window never shows any other site). Everything else stays denied.
  const allowed=permission=>permission==='clipboard-sanitized-write'||permission==='clipboard-read';
  session.defaultSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents,permission)=>allowed(permission));
  backend=fork(path.join(app.getAppPath(),'server.js'),[],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',VIBEDECK_PORT:'0',VIBEDECK_DATA_DIR:app.getPath('userData'),VIBEDECK_VAULT:'1'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  // Drain child pipes so extended use cannot stall the local engine.
  backend.stdout.on('data',()=>{});
  backend.stderr.on('data',()=>{});
  let ready=false;
  const timer=setTimeout(()=>{if(!ready){dialog.showErrorBox('VibeDeck could not start','The local engine did not start within 30 seconds.');app.quit();}},30000);
  backend.on('message',message=>{
    if(message.type==='vault'){
      try {
        if(!safeStorage.isEncryptionAvailable())throw Error('Secure storage is unavailable. Save the key for this session only.');
        if(!/^[a-f0-9-]{36}$/.test(message.id||''))throw Error('Invalid connection ID.');
        const file=path.join(app.getPath('userData'),'provider-keys.enc');
        const values=fs.existsSync(file)?JSON.parse(safeStorage.decryptString(fs.readFileSync(file))):{};
        let result='';
        if(message.action==='get')result=values[message.id]||'';
        else {
          if(message.action==='set' && typeof message.key==='string' && message.key.length<=4096)values[message.id]=message.key;
          else if(message.action==='delete')delete values[message.id];else throw Error('Invalid credential operation.');
          const bytes=safeStorage.encryptString(JSON.stringify(values));
          fs.writeFileSync(file+'.tmp',bytes,{mode:0o600});fs.renameSync(file+'.tmp',file);
        }
        backend.send({type:'vaultResult',requestId:message.requestId,result});
      } catch {backend.send({type:'vaultResult',requestId:message.requestId,error:'Secure key storage could not be accessed. Use a session-only key or check your operating-system keychain.'});}
      return;
    }
    if(message.type==='pickFolder'){
      const options={title:typeof message.title==='string'?message.title:'Choose a project folder',properties:['openDirectory','createDirectory'],defaultPath:typeof message.defaultPath==='string'?message.defaultPath:undefined};
      (window?dialog.showOpenDialog(window,options):dialog.showOpenDialog(options))
        .then(result=>backend.send({type:'pickFolderResult',requestId:message.requestId,dir:result.canceled?'':result.filePaths[0]||''}))
        .catch(()=>backend.send({type:'pickFolderResult',requestId:message.requestId,dir:''}));
      return;
    }
    if(message.type!=='ready'||ready)return;ready=true;clearTimeout(timer);
    const origin=new URL(message.url).origin;
    // The page draws its own title bar; Windows and Linux keep native window buttons drawn over it,
    // macOS keeps its traffic lights inset into it.
    const chrome=process.platform==='darwin'
      ?{titleBarStyle:'hiddenInset',trafficLightPosition:{x:14,y:13}}
      :{titleBarStyle:'hidden',titleBarOverlay:{color:'#08090b',symbolColor:'#9a9ea9',height:40}};
    window=new BrowserWindow({width:1440,height:960,minWidth:960,minHeight:640,title:'VibeDeck',backgroundColor:'#08090b',icon:path.join(app.getAppPath(),'icon.png'),show:false,...chrome,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.removeMenu();
    // Links clicked in a terminal pane open in the default browser. Only web addresses, and never the
    // engine's own address (it carries the session token). No window is ever opened inside the app.
    window.webContents.setWindowOpenHandler(({url})=>{
      try {const u=new URL(url);if((u.protocol==='http:'||u.protocol==='https:')&&u.origin!==origin)shell.openExternal(u.href);} catch {}
      return {action:'deny'};
    });
    window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
    window.once('ready-to-show',()=>window.show());
    window.loadURL(message.url);
  });
  backend.on('error',error=>{dialog.showErrorBox('VibeDeck engine error',error.message);app.quit();});
  backend.on('exit',()=>{clearTimeout(timer);if(!quitting){dialog.showErrorBox('VibeDeck engine stopped','Restart VibeDeck to reconnect to your workspace.');app.quit();}});
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitting||!backend?.connected)return;
  event.preventDefault();quitting=true;backend.send({type:'shutdown'});
  backend.once('exit',()=>app.quit());
  setTimeout(()=>{backend.kill();app.quit();},3000).unref();
});
