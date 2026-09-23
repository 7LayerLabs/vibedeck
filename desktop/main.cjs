const {app,BrowserWindow,dialog,session} = require('electron');
const {fork,execFileSync} = require('node:child_process');
const path=require('node:path');
let backend,window,quitting=false;
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(()=>{
  if(process.platform==='darwin'){
    try {process.env.PATH=execFileSync(process.env.SHELL||'/bin/zsh',['-ilc','printf "%s" "$PATH"'],{encoding:'utf8',timeout:5000}).trim();} catch {}
  }
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  backend=fork(path.join(app.getAppPath(),'server.js'),[],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',VIBEDECK_PORT:'0',VIBEDECK_DATA_DIR:app.getPath('userData')},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  // Drain child pipes so extended use cannot stall the local engine.
  backend.stdout.on('data',()=>{});
  backend.stderr.on('data',()=>{});
  let ready=false;
  const timer=setTimeout(()=>{if(!ready){dialog.showErrorBox('VibeDeck could not start','The local engine did not start within 30 seconds.');app.quit();}},30000);
  backend.on('message',message=>{
    if(message.type!=='ready'||ready)return;ready=true;clearTimeout(timer);
    const origin=new URL(message.url).origin;
    window=new BrowserWindow({width:1440,height:960,minWidth:860,minHeight:640,title:'VibeDeck',backgroundColor:'#edf1f5',icon:path.join(app.getAppPath(),'icon.png'),show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
    window.removeMenu();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
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
