import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';

export type ApplicationFormat='native'|'workspace'|'html';
export type ApplicationSnapshot={appId:string;format:ApplicationFormat;harness:string;version:string|number;token:string;content:Record<string,any>};
type Options={
  /** Must use the authenticated owner's existing HTML adapter, never body.owner. */
  htmlRead?:(owner:string,appId:string)=>Promise<{app:Record<string,any>;html:string;store:unknown}>;
  harnessOf?:(owner:string,appId:string)=>string|undefined;
  /** Existing shared native demos are opt-in; private applications stay exact-owner. */
  includeSharedNative?:boolean;
};
const fail=(message:string,status=400,code='application_access_invalid')=>Object.assign(new Error(message),{status,code});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const object=(v:unknown):v is Record<string,any>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
function ownerOf(value:string){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>60)throw fail('An authenticated owner is required',401,'authentication_required');return value;}
function idOf(value:string){if(typeof value!=='string'||!/^[-A-Za-z0-9_.:]{1,200}$/.test(value))throw fail('Invalid application identifier');return value;}
function integer(value:unknown,fallback:number,min:number,max:number){if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw fail('Invalid page bounds');return Number(value);}
function parse(text:string){try{return JSON.parse(text);}catch{throw fail('Saved application content could not be read',500,'application_content_invalid');}}

/** Read-only, format-neutral application inventory. It never reads provider,
 * credential, user-settings or unrelated-owner tables into model context.
 * Full snapshots are for trusted orchestration; paged reads are for model tools. */
export function createApplicationAccess(db:Database.Database,options:Options={}){
  const table=(name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const nativeOwner=options.includeSharedNative?"owner IN ('',?)":"owner=?";
  function stored(owner:string,id:string):{format:ApplicationFormat;row:any}{
    ownerOf(owner);idOf(id);
    if(table('rich_workspaces')){const row=db.prepare('SELECT * FROM rich_workspaces WHERE owner=? AND app_id=?').get(owner,id);if(row)return {format:'workspace',row};}
    if(table('complete_apps')){const row=db.prepare('SELECT * FROM complete_apps WHERE owner=? AND app_id=?').get(owner,id);if(row)return {format:'html',row};}
    if(table('agent_apps')){const row=db.prepare('SELECT * FROM agent_apps WHERE '+nativeOwner+' AND app_id=?').get(owner,id);if(row)return {format:'native',row};}
    throw fail('Application not found',404,'app_missing');
  }
  function describe(owner:string,id:string,format:ApplicationFormat,info:any,row:any){
    const harness=options.harnessOf?.(owner,id)||info.harness||(format==='html'?'dsh':format==='workspace'?'codex':'native');
    return {appId:id,format,harness,name:String(info.name||row.name||id),description:String(info.description||row.description||''),version:info.revision??info.version??row.version??0};
  }
  function list(owner:string,paging:{offset?:number;limit?:number}={}){
    ownerOf(owner);const offset=integer(paging.offset,0,0,Number.MAX_SAFE_INTEGER),limit=integer(paging.limit,100,1,200);
    const apps:Array<ReturnType<typeof describe>>=[];
    if(table('agent_apps'))for(const row of db.prepare('SELECT * FROM agent_apps WHERE '+nativeOwner).all(owner) as any[]){const pkg=parse(row.package_json);apps.push(describe(owner,row.app_id,'native',pkg.manifest||{},row));}
    if(table('rich_workspaces'))for(const row of db.prepare('SELECT * FROM rich_workspaces WHERE owner=?').all(owner) as any[]){const saved=parse(row.snapshot_json);apps.push({...describe(owner,row.app_id,'workspace',saved.app||{},row),version:saved.version??0});}
    if(table('complete_apps'))for(const row of db.prepare('SELECT * FROM complete_apps WHERE owner=?').all(owner) as any[])apps.push(describe(owner,row.app_id,'html',parse(row.info_json),row));
    apps.sort((a,b)=>a.appId.localeCompare(b.appId));
    return {apps:apps.slice(offset,offset+limit),total:apps.length,offset,nextOffset:offset+limit<apps.length?offset+limit:null};
  }
  async function snapshot(owner:string,id:string):Promise<ApplicationSnapshot>{
    const entry=stored(owner,id),row=entry.row;let content:Record<string,any>,info:any,version:string|number;
    if(entry.format==='native'){
      content={appPackage:parse(row.package_json),data:parse(row.data_json),runtimeState:parse(row.runtime_state_json)};
      info=content.appPackage.manifest||{};version=row.version??info.version??0;
    }else if(entry.format==='workspace'){
      content=parse(row.snapshot_json);if(!object(content))throw fail('Invalid saved workspace',500,'application_content_invalid');
      info=content.app||{};version=content.version??0;
    }else{
      if(!options.htmlRead)throw fail('HTML application content reader is unavailable',503,'application_content_unavailable');
      const loaded=await options.htmlRead(owner,id);
      if(!object(loaded)||!object(loaded.app)||typeof loaded.html!=='string'||!Object.hasOwn(loaded,'store'))throw fail('HTML reader did not return complete source and saved state',502,'application_content_incomplete');
      // Ownership may change while an external adapter is being read.
      stored(owner,id);
      if(loaded.app.id!==undefined&&loaded.app.id!==id&&'dsh_'+loaded.app.id!==id)throw fail('HTML application identity does not match',502,'application_identity_mismatch');
      content={app:loaded.app,html:loaded.html,store:loaded.store};info=loaded.app;version=info.revision??info.version??0;
    }
    const harness=describe(owner,id,entry.format,info,row).harness;
    // Return detached data so editing a trusted snapshot cannot mutate a cached
    // adapter object before validation and explicit publication.
    content=JSON.parse(JSON.stringify(content));
    const token=hash(JSON.stringify({appId:id,format:entry.format,harness,version,content}));
    return {appId:id,format:entry.format,harness,version,token,content};
  }
  async function read(owner:string,id:string,paging:{section?:'all'|'source'|'state'|'records';offset?:number;maxChars?:number;expectedToken?:string}={}){
    const current=await snapshot(owner,id),section=paging.section??'all';
    if(!['all','source','state','records'].includes(section))throw fail('Unknown application section');
    if(paging.expectedToken!==undefined&&paging.expectedToken!==current.token)throw fail('Application changed; restart reading from its current version',409,'application_conflict');
    const offset=integer(paging.offset,0,0,Number.MAX_SAFE_INTEGER),maxChars=integer(paging.maxChars,12000,1,32000),c=current.content;
    const selected=section==='all'?c:current.format==='native'?(section==='source'?c.appPackage:section==='state'?c.runtimeState:c.data):current.format==='workspace'?(section==='source'?c.tree:section==='state'?c.interactionState:c.records):(section==='source'?c.html:c.store);
    const text=JSON.stringify(selected);if(text===undefined)throw fail('Requested saved application section is missing',502,'application_content_incomplete');
    if(offset>text.length)throw fail('Page offset exceeds section length');
    const end=Math.min(text.length,offset+maxChars);
    return {appId:id,format:current.format,harness:current.harness,version:current.version,token:current.token,section,encoding:'json',offset,totalChars:text.length,content:text.slice(offset,end),nextOffset:end<text.length?end:null,sha256:hash(text)};
  }
  return {list,snapshot,read};
}
