import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';

const secretKey=/api.?key|authorization|password|passwd|secret|credential|cookie|private.?key|access.?token|refresh.?token|id.?token|^token$|^headers$|photo.?data|image.?data|^env(?:ironment)?$/i;
export function cleanDevelopmentContext(value:any):any {
  const secrets=new Set<string>();
  const discover=(v:any,sensitive=false)=>{if(Array.isArray(v))v.forEach(x=>discover(x,sensitive));else if(v&&typeof v==='object')Object.entries(v).forEach(([k,x])=>discover(x,sensitive||secretKey.test(k)));else if(typeof v==='string'){
    if(sensitive&&v.length>=6)secrets.add(v);
    try {const parsed=JSON.parse(v);if(parsed&&typeof parsed==='object')discover(parsed,sensitive);}catch{}
  }};discover(value);
  const clean=(v:any):any=>{
    if(Array.isArray(v))return v.map(clean);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,secretKey.test(k)?'[REDACTED]':clean(x)]));
    if(typeof v!=='string')return v;
    try{const parsed=JSON.parse(v);if(parsed&&typeof parsed==='object')return clean(parsed);}catch{}
    let s=v.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED_PRIVATE_KEY]')
      .replace(/data:image\/[^\s"'<>]+/gi,'[IMAGE_DATA_OMITTED]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,'[REDACTED_AUTH]')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[REDACTED]@')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,'$1[REDACTED]')
      .replace(/([?&](?:key|token|secret|signature|sig|api_key|access_token)=)[^&\s"'<>]+/gi,'$1[REDACTED]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[REDACTED_TOKEN]');
    for(const item of [...secrets].sort((a,b)=>b.length-a.length))s=s.split(item).join('[REDACTED]');return s;
  };return clean(value);
}

/** Snapshot only the authenticated owner's application and request context.
 * Source files are independently pinned: a Git revision is never represented as
 * the running deployment. Large contexts remain files, not a truncated prompt. */
export function createDevelopmentContext(db:Database.Database,options:{runtimeRoot:string;dshRoot?:string;memoryOf?:(owner:string,appId:string)=>any}) {
 return async(owner:string,appId?:string)=>{
  if(!owner)throw new Error('Development context requires an owner');
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r=>r.name));
  const gaps:string[]=[];
  const query=(table:string,sql:string,...params:any[])=>{if(!tables.has(table)){gaps.push('Unavailable table: '+table);return [];}return db.prepare(sql).all(...params) as any[];};
  const native=appId?query('agent_apps','SELECT * FROM agent_apps WHERE owner=? AND app_id=?',owner,appId):[];
  const rich=appId?query('rich_workspaces','SELECT * FROM rich_workspaces WHERE owner=? AND app_id=?',owner,appId):[];
  const complete=appId?query('complete_apps','SELECT * FROM complete_apps WHERE owner=? AND app_id=?',owner,appId):[];
  const appKnown=Boolean(native.length||rich.length||complete.length);
  const steps=appId?query('agent_workflow_execution_steps','SELECT * FROM agent_workflow_execution_steps WHERE owner=? AND app_id=? ORDER BY id',owner,appId):[];
  const jobs=appId?query('rich_workspace_jobs','SELECT * FROM rich_workspace_jobs WHERE owner=? AND app_id=? ORDER BY rowid',owner,appId):[];
  const audit=native.length?query('agent_action_audit','SELECT a.* FROM agent_action_audit a JOIN agent_apps p ON p.app_id=a.app_id WHERE p.owner=? AND a.app_id=? ORDER BY a.id',owner,appId):[];
  const turns=native.length?query('agent_workflow_turns','SELECT t.* FROM agent_workflow_turns t JOIN agent_apps p ON p.app_id=t.app_id WHERE p.owner=? AND t.app_id=? ORDER BY t.id',owner,appId):[];
  const hostActions=appId?query('complete_host_actions','SELECT * FROM complete_host_actions WHERE owner=? AND app_id=? ORDER BY rowid',owner,appId):[];
  const bindings=appId?query('complete_service_bindings','SELECT * FROM complete_service_bindings WHERE owner=? AND app_id=? ORDER BY rowid',owner,appId):[];
  const chat=query('chat_history','SELECT * FROM chat_history WHERE owner=? ORDER BY id',owner);
  const catalog=query('agent_apps','SELECT app_id,name,description,version,updated_at FROM agent_apps WHERE owner=? ORDER BY app_id',owner);
  const richCatalog=query('rich_workspaces','SELECT app_id FROM rich_workspaces WHERE owner=? ORDER BY app_id',owner);
  const dsh:any[]=[];const appFiles:any[]=[];let appBytes=0;
  const fileLimit=8*1024*1024,totalLimit=32*1024*1024;
  const safePart=(value:any):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);
  const values=(value:any):any[]=>Array.isArray(value)?value:value&&typeof value==='object'?Object.values(value):[];
  if(appId?.startsWith('dsh_')){
   const id=appId.slice(4);
   if(!safePart(id))gaps.push('Invalid selected HTML app identifier');
   else if(!options.dshRoot)gaps.push('DSH account source is not configured; external HTML/history not collected');
   else {
    let base:string|undefined;
    try{base=fs.realpathSync(options.dshRoot);}catch{gaps.push('DSH account source unavailable');}
    if(base)for(const account of [owner,'liveuiagent:'+owner]){
     const accountRef=createHash('sha256').update(account).digest('hex'),accountRoot=path.join(base,accountRef);
     // Source names are host-selected, never paths accepted from stored metadata.
     const read=(relative:string,kind:string,include=true):Buffer|undefined=>{
      let fd:number|undefined;
      try{
       const segments=relative.split('/');if(segments.some(x=>!x||x==='.'||x==='..'))throw new Error('path');
       let current=accountRoot;
       for(const part of [null,...segments.slice(0,-1)]){
        if(part)current=path.join(current,part);
        const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('path');
       }
       const file=path.join(accountRoot,relative);
       fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
       const stat=fs.fstatSync(fd);
       if(!stat.isFile()||stat.nlink!==1)throw new Error('nonregular');
       if(stat.size>fileLimit||appBytes+stat.size>totalLimit){gaps.push('DSH context byte budget exceeded: '+accountRef+'/'+relative);return;}
       const chunks:Buffer[]=[];let count=0;
       while(true){const chunk=Buffer.alloc(Math.min(65536,fileLimit+1-count));const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;count+=n;if(count>fileLimit||appBytes+count>totalLimit){gaps.push('DSH context byte budget exceeded: '+accountRef+'/'+relative);return;}chunks.push(chunk.subarray(0,n));}
       const raw=Buffer.concat(chunks);appBytes+=raw.length;
       const content=raw.toString('utf8');if(content.includes('\u0000')||!Buffer.from(content,'utf8').equals(raw)){gaps.push('DSH binary file excluded: '+accountRef+'/'+relative);return;}
       if(include)appFiles.push({kind,accountRef,path:relative,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),content});
       return raw;
      }catch(error:any){if(error?.code!=='ENOENT')gaps.push('DSH unreadable or unsafe source: '+accountRef+'/'+relative);else if(include)gaps.push('DSH related file unavailable: '+accountRef+'/'+relative);return;}
      finally{if(fd!==undefined)fs.closeSync(fd);}
     };
     const rawState=read('state.json','dsh_account_state',false);if(!rawState)continue;
     let state:any;try{state=JSON.parse(rawState.toString('utf8'));}catch{gaps.push('DSH account state JSON invalid: '+accountRef);continue;}
     const apps=values(state.apps).filter(a=>a&&a.id===id),relatedJobs=values(state.jobs).filter(j=>j&&j.appId===id);
     if(!apps.length&&!relatedJobs.length)continue;
     dsh.push({accountRef,apps,jobs:relatedJobs,stateSource:{path:'state.json',sha256:createHash('sha256').update(rawState).digest('hex'),bytes:rawState.length,selection:'only exact app id; other app records excluded'}});
     const walk=(relative:string,kind:string)=>{
      const folder=path.join(accountRoot,relative);
      try{
       const stat=fs.lstatSync(folder);if(stat.isSymbolicLink()||!stat.isDirectory()){gaps.push('DSH unsafe directory excluded: '+accountRef+'/'+relative);return;}
       for(const item of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
        const child=relative+'/'+item.name;
        if(item.name.startsWith('.')||/credential|secret|auth|cookie|^node_modules$|^dsh-home$|^user-memory\.json$/i.test(item.name)){gaps.push('DSH sensitive path excluded: '+accountRef+'/'+child);continue;}
        if(item.isSymbolicLink()){gaps.push('DSH symlink excluded: '+accountRef+'/'+child);continue;}
        if(item.isDirectory())walk(child,kind);else read(child,kind);
       }
      }catch(error:any){gaps.push('DSH related directory unavailable: '+accountRef+'/'+relative);}
     };
     walk('apps/'+id,'dsh_app_current');
     for(const job of relatedJobs){if(!safePart(job.id)){gaps.push('DSH invalid job id omitted');continue;}read('runs/'+job.id+'.json','dsh_run_metadata');walk('runs/'+job.id,'dsh_run');}
    }
   }
  }
  if(appId&&!appKnown&&!dsh.length&&!steps.length&&!jobs.length&&!hostActions.length)gaps.push('Selected app has no exact owned source; no other app context substituted');
  const runtime:any[]=[];let bytes=0;
  // Only first-party compiled source and static code, never env/config/data.
  for(const relative of ['dist-server/server','dist']){
   const folder=path.join(options.runtimeRoot,relative);if(!fs.existsSync(folder)){gaps.push('Runtime code unavailable: '+relative);continue;}
   for(const name of fs.readdirSync(folder).sort()){
    if(!/\.(?:js|css|html)$/.test(name))continue;
    const file=path.join(folder,name),st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())continue;
    if(st.size>8*1024*1024||bytes+st.size>32*1024*1024){gaps.push('Runtime source exceeds context budget: '+relative+'/'+name);continue;}
    const raw=fs.readFileSync(file);bytes+=raw.length;
    runtime.push({path:relative+'/'+name,bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),content:raw.toString('utf8')});
   }
  }
  const context=cleanDevelopmentContext({scope:{owner,appId:appId||null,capturedAt:new Date().toISOString(),state:'current runtime; historical requests carry their own timestamps',gaps},runtime,
    application:{native,rich,complete,dsh},executionHistory:steps,workspaceJobs:jobs,actionHistory:audit,workflowTurns:turns,hostActions,serviceBindings:bindings,appFiles,chatHistory:chat,
    ownedApplications:{native:catalog,rich:richCatalog},memory:await options.memoryOf?.(owner,appId||'global')??[],
    capabilities:{source:'Complete tracked repository in the development workspace; deployed modules separately pinned in runtime context',tools:['files','read','search','edit','test'],publication:'Changes remain in the development workspace until reviewed and deployed; never report a patch as a live fix'}});
  context.fileManifest=[...context.runtime,...context.appFiles].map((item:any)=>({path:item.path,accountRef:item.accountRef??null,sourceBytes:item.bytes,sourceSHA256:item.sha256,
   contextSHA256:createHash('sha256').update(typeof item.content==='string'?item.content:JSON.stringify(item.content)).digest('hex'),sanitized:true}));
  context.scope.gaps.push('Historical rows may have been pruned; app files are current snapshots, not guaranteed failure-time files');
  return context;
 };
}
