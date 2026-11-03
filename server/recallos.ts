import type Database from 'better-sqlite3';
import {createHash} from 'node:crypto';

type Row={id:string;scope:string;content:string;dimension:string;condition:string;evidence:any[];updatedAt:string;expiresAt:string|null;source:string;active:boolean;version?:string};
type Snapshot={revision:string;rules:any[]};
export type RecallOSBackend=ReturnType<typeof createRecallOSBackend>;

export function createRecallOSBackend(db:Database.Database, options:{url?:string;token?:string}={}) {
  const url=options.url||process.env.RECALLOS_URL;
  const token=options.token||process.env.RECALLOS_TOKEN;
  if(!url||!token)throw Error('RecallOS URL and token are required');
  const states=new Map<string,Snapshot>();
  const migrated=new Set<string>();
  const refreshing=new Map<string,Promise<void>>();
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  async function rpc(owner:string,operation:string,args:Record<string,any>={}) {
    if(!owner)throw Object.assign(Error('An authenticated owner is required for RecallOS'),{status:401});
    const response=await fetch(url!.replace(/\/+$/,'')+'/v1/memory',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify({owner,operation,arguments:args}),signal:AbortSignal.timeout(30000),
    });
    const value:any=await response.json();
    if(!response.ok)throw Object.assign(Error(response.status===409?'Memory changed in another session. Refresh before editing.':'RecallOS is unavailable'),{status:response.status===409?409:503,code:response.status===409?'memory_conflict':'memory_unavailable'});
    return value;
  }
  function recordId(rule:any) {
    return rule.attributes?.origin==='liveui'?rule.attributes.liveui_id:
      'ro-'+hash(rule.scope+'/'+(rule.project||'')+'/'+rule.id).slice(0,32);
  }
  function list(owner:string):Row[] {
    return (states.get(owner)?.rules||[]).filter(rule=>!rule.project||rule.attributes?.origin==='liveui').map(rule=>{
      const a=rule.attributes||{},own=a.origin==='liveui',expiresAt=a.expires_at||null;
      return {id:recordId(rule),version:hash(JSON.stringify(rule)),scope:own?(a.liveui_scope||'global'):'global',content:rule.text,
        dimension:a.dimension||rule.id,condition:a.condition||(rule.scope==='global'?'Relevant tasks':'Task scenario: '+rule.scope),
        evidence:[{eventId:rule.source_id,quote:rule.evidence}],updatedAt:a.imported_updated_at||rule.updated_at,expiresAt,
        source:own?(a.memory_kind||'interaction'):(rule.scope==='global'?'explicit':'interaction'),
        active:!expiresAt||Date.parse(expiresAt)>Date.now()};
    }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
  function capture(owner:string){return states.get(owner);}
  async function upsert(owner:string,row:Partial<Row>&{id:string;scope:string;content:string},source:string,evidence:string,base?:string,baseline?:Snapshot) {
    const state=baseline||states.get(owner);if(!state)throw Error('RecallOS snapshot was not loaded');
    const old=state.rules.find(rule=>recordId(rule)===row.id);
    if(old&&old.attributes?.origin==='liveui'&&(old.attributes.liveui_scope||'global')!==row.scope)
      throw Object.assign(Error('Create a new memory to change its scope'),{status:409,code:'memory_scope_conflict'});
    const project=old?.project||(row.scope==='global'?null:'liveui-'+hash(row.scope).slice(0,24));
    const attributes=old&&old.attributes?.origin!=='liveui'?{...(old.attributes||{}),
      condition:row.condition||old.attributes?.condition||'Relevant tasks',expires_at:row.expiresAt===undefined?(old.attributes?.expires_at||null):row.expiresAt}:
      {origin:'liveui',liveui_id:row.id,liveui_scope:row.scope,memory_kind:row.source||'interaction',
       dimension:row.dimension||row.id,condition:row.condition||'Relevant tasks',expires_at:row.expiresAt||null,evidence_events:row.evidence||[],...(source.startsWith('liveui-import/')&&row.updatedAt?{imported_updated_at:row.updatedAt}:{})};
    return rpc(owner,'apply',{rule_id:old?.id||'ui-'+hash(row.id).slice(0,32),scope:old?.scope||'liveui',project,
      text:row.content,source_id:source,evidence:evidence.slice(0,2000)||row.content,
      base_revision:base||state.revision,attributes});
  }
  async function refresh(owner:string) {
    if(!owner)return;
    if(refreshing.has(owner))return refreshing.get(owner);
    const work=(async()=>{
      states.set(owner,await rpc(owner,'snapshot'));
      if(!migrated.has(owner)){
        const explicit=db.prepare('SELECT id,scope,content,expires_at AS expiresAt,updated_at AS updatedAt FROM personal_memory WHERE owner=?').all(owner) as any[];
        const contextual=db.prepare('SELECT id,scope,content,dimension,condition,evidence_json,expires_at AS expiresAt,updated_at AS updatedAt FROM personal_context_memory WHERE owner=?').all(owner) as any[];
        const base=states.get(owner)!.revision;
        for(const row of [...explicit.map(r=>({...r,source:'explicit'})),...contextual.map(r=>({...r,source:'interaction'}))]){
          await upsert(owner,{...row,evidence:row.evidence_json?JSON.parse(row.evidence_json):[]},'liveui-import/'+hash(owner+'/'+row.source+'/'+row.id),
            row.evidence_json?JSON.parse(row.evidence_json).map((e:any)=>e.quote).join('\n'):row.content,base);
        }
        migrated.add(owner);
        states.set(owner,await rpc(owner,'snapshot'));
      }
    })();
    refreshing.set(owner,work);
    try{await work}finally{refreshing.delete(owner)}
  }
  async function remove(owner:string,id:string,source:string,baseline?:Snapshot) {
    const state=baseline||states.get(owner),old=state?.rules.find(rule=>recordId(rule)===id);
    if(!old)return false;
    await rpc(owner,'apply',{rule_id:old.id,scope:old.scope,project:old.project,text:null,
      source_id:source,evidence:'User requested forgetting this memory',base_revision:state!.revision});
    await refresh(owner);return true;
  }
  function status(owner:string){return {enabled:true,brand:'RecallOS · 知我',revision:states.get(owner)?.revision};}
  return {list,refresh,upsert,remove,status,capture};
}
