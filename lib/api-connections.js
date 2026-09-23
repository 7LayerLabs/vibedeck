'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');

function validateConnection(input) {
  const name=String(input?.name||'').trim();
  if(!name || name.length>80)throw Error('Enter a connection name up to 80 characters.');
  if(!['openai','anthropic'].includes(input.protocol))throw Error('Choose a supported API format.');
  let url;try {url=new URL(input.baseUrl);}catch{throw Error('Enter a valid API base URL.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:' && !(local && url.protocol==='http:'))throw Error('Use HTTPS for hosted APIs. HTTP is allowed only for local servers.');
  if(url.username||url.password||url.search||url.hash)throw Error('Use a base URL without credentials, query parameters or fragments.');
  const model=String(input.model||'').trim();
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(model))throw Error('Enter the exact model ID supplied by your provider or local server.');
  return {name,protocol:input.protocol,baseUrl:url.href.replace(/\/$/,''),model,local};
}

class Connections {
  constructor(file,vault){this.file=file;this.vault=vault;this.keys=new Map();this.items=[];
    try {this.items=JSON.parse(fs.readFileSync(file,'utf8')).map(c=>({...validateConnection(c),id:c.id,remember:!!c.remember})).filter(c=>/^[a-f0-9-]{36}$/.test(c.id));}catch{}
  }
  list(){return this.items.map(c=>({...c,hasKey:this.keys.has(c.id)||c.remember}));}
  async save(input){
    const clean=validateConnection(input);const old=this.items.find(c=>c.id===input.id);
    if(!old && this.items.length>=30)throw Error('You can save up to 30 connections.');
    const id=old?.id||crypto.randomUUID();
    const sameEndpoint=old?.baseUrl===clean.baseUrl && old?.protocol===clean.protocol;
    let key=String(input.apiKey||'').trim();
    if(!key && old && sameEndpoint)key=this.keys.get(id)||(old.remember?await this.vault('get',id):'');
    if(key.length>4096 || /[\r\n]/.test(key))throw Error('Invalid API key.');
    if(!clean.local && !key)throw Error('Enter an API key for this hosted connection.');
    const remember=!!input.remember && !!key;
    // A changed destination never silently inherits an existing credential.
    if(remember)await this.vault('set',id,key);
    else if(old?.remember)await this.vault('delete',id);
    const record={...clean,id,remember};
    const next=[...this.items.filter(c=>c.id!==id),record];
    if(next.length>30)throw Error('You can save up to 30 connections.');
    fs.writeFileSync(this.file,JSON.stringify(next,null,2));this.items=next;
    if(key)this.keys.set(id,key);else this.keys.delete(id);
    return record;
  }
  async remove(id){const found=this.items.find(c=>c.id===id);if(!found)return;
    if(found.remember)await this.vault('delete',id);
    const next=this.items.filter(c=>c.id!==id);fs.writeFileSync(this.file,JSON.stringify(next,null,2));this.items=next;this.keys.delete(id);
  }
  async get(id){const c=this.items.find(c=>c.id===id);if(!c)throw Error('Select a saved API connection.');
    const key=this.keys.get(id)||(c.remember?await this.vault('get',id):'');
    if(!c.local&&!key)throw Error(`Enter the API key for ${c.name} in Connections.`);
    return {...c,apiKey:key};
  }
}

function executeApiStage({step,prompt,connections,fetchImpl=fetch,timeoutMs=600000}){
  const controller=new AbortController();let cancelled=false;
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const promise=(async()=>{
    const c=await connections.get(step.connectionId);
    if(controller.signal.aborted)throw Error('Request stopped.');
    const model=step.model||c.model;
    const headers={'Content-Type':'application/json'};
    const text=`You are responding in VibeDeck. You have no filesystem or command tools. Return analysis or proposed code, not claims of file changes or tests executed.\n\n${prompt}`;
    const anthropic=c.protocol==='anthropic';
    if(c.apiKey){if(anthropic)headers['x-api-key']=c.apiKey;else headers.Authorization='Bearer '+c.apiKey;}
    if(anthropic)headers['anthropic-version']='2023-06-01';
    const body={model,messages:[{role:'user',content:text}],stream:false,...(anthropic?{max_tokens:8192}:{})};
    const response=await fetchImpl(c.baseUrl+(anthropic?'/messages':'/chat/completions'),{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw Error(`${c.name} returned HTTP ${response.status}. Check the key, model ID and API access.`);}
    const reader=response.body.getReader();const chunks=[];let size=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw Error('The API response exceeded 2 MB.');}chunks.push(Buffer.from(value));}} finally {reader.releaseLock();}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(anthropic && data.stop_reason!=='end_turn' && data.stop_reason!=='stop_sequence')throw Error('The API response was incomplete. Try a smaller request.');
    if(!anthropic && data.choices?.[0]?.finish_reason!=='stop')throw Error('The API response was incomplete or requested unsupported tools.');
    const answer=anthropic?data.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n'):data.choices?.[0]?.message?.content;
    if(typeof answer!=='string'||!answer.trim())throw Error('The provider returned no text answer.');
    return answer.trim();
  })().catch(error=>{if(controller.signal.aborted)throw Error(cancelled?'API request cancelled.':'API request timed out.');throw error;}).finally(()=>clearTimeout(timer));
  return {promise,cancel(){cancelled=true;controller.abort();}};
}
module.exports={Connections,validateConnection,executeApiStage};
