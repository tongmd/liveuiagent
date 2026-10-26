import {createHash} from 'node:crypto';
import {opaqueIdentity} from './opaque-identity.js';
import {projectBusinessEvidence} from './grounding-evidence.js';
export const SUPPORTING_PROTOCOL='native-readonly-supporting-v1';
export type SupportingScope={owner:string;appId:string};
export type SupportingSection={role:'catalog_options'|'supporting_results';title:string;rows:Array<{name:string;id?:string;detail?:string}>};
export type SupportingRead={api:string;order:number;request:unknown;response:unknown;method:string;source?:string;ok:boolean;executionState:string;requestSource:string;omittedAuthenticationKeys?:string[]};
export type SupportingPreparation={protocol:typeof SUPPORTING_PROTOCOL;sections:SupportingSection[];bindings:Array<Array<{source:number;rowPointer:string;namePointer:string;idPointer?:string;detailPointer?:string}>>;sources:SupportingRead[];lastExternalWriteOrder:number;lastLocalWriteOrder:number;proposalSha256:string};
export type SupportingSeal=SupportingPreparation&{scope:SupportingScope;reviewed:true;sha256:string};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const escaped=(s:string)=>s.replace(/~/g,'~0').replace(/\//g,'~1');
const object=(x:any)=>x&&typeof x==='object'&&!Array.isArray(x);
function keys(x:any,allowed:string[]){if(!object(x)||Object.keys(x).some(k=>!allowed.includes(k)))throw Error('supporting_projection: unknown fields or non-object');}
// A row may contain nested scalar objects, but a nested array starts separate
// structural rows. Never combine identity/name/detail across its child rows.
function leaves(x:any,path=''):Array<{path:string;value:unknown}>{if(x===null||typeof x!=='object')return[{path,value:x}];if(Array.isArray(x))return[];return Object.entries(x).flatMap(([k,v])=>leaves(v,`${path}/${escaped(k)}`));}
function elements(x:any,path=''):Array<{path:string;value:any}>{if(!x||typeof x!=='object')return[];return Object.entries(x).flatMap(([k,v])=>[...(Array.isArray(x)?[{path:`${path}/${escaped(k)}`,value:v}]:[]),...elements(v,`${path}/${escaped(k)}`)]);}
/** Names/IDs come only from actual host call receipts, never from model-authored
 * receipt-shaped data or a free-form source pointer. This proves provenance;
 * semantic row role still needs the existing independent evaluator. */
export function prepareSupportingSections(raw:unknown,actualReads:SupportingRead[],lastExternalWriteOrder:number,lastLocalWriteOrder=-1):SupportingPreparation{
 if(raw===undefined)raw=[];
 if(!Array.isArray(raw))throw Error('supporting_projection: sections must be an array');
 const sections:SupportingSection[]=structuredClone(raw);const sources:SupportingRead[]=[];
 const bindings:SupportingPreparation['bindings']=[];
 const eligible=actualReads.filter(c=>{
  const local=c.source==='app-state';const response=c.response as any;
  const actualRead=local?(['app_state.read_record','app_state.list_records'].includes(c.api)&&c.requestSource==='host-bound-app-state-dispatched-arguments'&&response?.source==='app-state'&&response?.scope==='authenticated-current-owner-app'&&response?.persisted===true&&['read','list'].includes(response?.operation)):c.requestSource==='bridge-returned-request';
  return c.method==='GET'&&c.ok===true&&c.executionState==='succeeded'&&actualRead&&Number.isSafeInteger(c.order)&&c.order>(local?lastLocalWriteOrder:lastExternalWriteOrder);
 })
  .map(c=>{const p=projectBusinessEvidence(c);return{...(p.value as SupportingRead),...((p.omittedAuthenticationKeys.length||c.omittedAuthenticationKeys?.length)?{omittedAuthenticationKeys:[...new Set([...(c.omittedAuthenticationKeys??[]),...p.omittedAuthenticationKeys])]}:{})};});
 for(const section of sections){
  keys(section,['role','title','rows']);if(!['catalog_options','supporting_results'].includes(section.role)||typeof section.title!=='string'||!section.title.trim()||!Array.isArray(section.rows)||!section.rows.length)throw Error('supporting_projection: invalid readonly section');
  const sectionBindings:SupportingPreparation['bindings'][number]=[];
  type Candidate={call:SupportingRead;rowPointer:string;namePointer:string;idPointer?:string;detailPointer?:string;semanticKey:string;groupKey:string};
  const sectionCandidates:Candidate[][]=[];
  for(const row of section.rows){
   keys(row,['name','id','detail']);if(typeof row.name!=='string'||!row.name.trim()||(row.detail!==undefined&&typeof row.detail!=='string')||(row.id!==undefined&&(typeof row.id!=='string'||opaqueIdentity(row.id)!==row.id||!row.id.trim())))throw Error('supporting_projection: invalid exact row values');
   const candidates:Candidate[]=[];
   for(const call of eligible)for(const element of [...elements(call.response),...(call.source==='app-state'&&(call.response as any)?.operation==='read'&&object((call.response as any)?.record)?[{path:'/record',value:(call.response as any).record}]:[])]){
    const values=leaves(element.value);const names=values.filter(v=>v.value===row.name);
    const ids=row.id===undefined?[undefined]:values.filter(v=>(typeof v.value==='string'||(typeof v.value==='number'&&Number.isSafeInteger(v.value)))&&String(v.value)===row.id);
    const details=row.detail===undefined?[undefined]:values.filter(v=>v.value===row.detail);
    for(const n of names)for(const id of ids)for(const detail of details){
     // A nested object with the same values is not a second row. Only an actual
     // array element is a candidate; differing objects with no real ID remain ambiguous.
     candidates.push({groupKey:hash({api:call.api,source:call.source??'external',collectionPointer:element.path.slice(0,element.path.lastIndexOf('/'))}),call,rowPointer:element.path,namePointer:element.path+n.path,...(id?{idPointer:element.path+id.path}:{}),...(detail?{detailPointer:element.path+detail.path}:{}),semanticKey:hash({api:call.api,...(row.id===undefined?{request:call.request,rowPointer:element.path}:{}),namePointer:n.path,idPointer:id?.path,detailPointer:detail?.path,rowValue:element.value})});
    }
   }
   sectionCandidates.push(candidates);
  }
  // The whole section must select one uniquely supported structural source
  // contract. This is not semantic type guessing: e.g. one saved preference
  // sharing a directory label cannot compete with the actual ten-value source.
  const groups=new Set(sectionCandidates[0].map(c=>c.groupKey));
  for(const candidates of sectionCandidates)for(const group of groups)if(!candidates.some(c=>c.groupKey===group))groups.delete(group);
  if(groups.size!==1)throw Error(`supporting_projection: ${groups.size?'ambiguous':'missing fresh actual'} section source`);
  for(const candidates of sectionCandidates){
   const unique=new Map<string,Candidate>();for(const c of candidates.filter(c=>groups.has(c.groupKey))){const prior=unique.get(c.semanticKey);if(!prior||c.call.order>prior.call.order)unique.set(c.semanticKey,c);}
   if(unique.size!==1)throw Error(`supporting_projection: ${unique.size?'ambiguous':'missing fresh actual'} source for row`);
   const bound=[...unique.values()][0];let index=sources.findIndex(c=>c.order===bound.call.order&&c.api===bound.call.api);if(index<0){index=sources.length;sources.push(bound.call);}
   const {rowPointer,namePointer,idPointer,detailPointer}=bound;sectionBindings.push({source:index,rowPointer,namePointer,...(idPointer?{idPointer}:{}),...(detailPointer?{detailPointer}: {})});
  }
  bindings.push(sectionBindings);
 }
 return{protocol:SUPPORTING_PROTOCOL,sections,bindings,sources,lastExternalWriteOrder,lastLocalWriteOrder,proposalSha256:hash({sections,bindings,sources,lastExternalWriteOrder,lastLocalWriteOrder})};
}
export function sealSupportingSections(prepared:SupportingPreparation,scope:SupportingScope,approval:unknown):SupportingSeal{
 if(!scope.owner.trim()||!scope.appId.trim())throw Error('supporting_projection: authenticated owner/app required');
 if(hash({sections:prepared.sections,bindings:prepared.bindings,sources:prepared.sources,lastExternalWriteOrder:prepared.lastExternalWriteOrder,lastLocalWriteOrder:prepared.lastLocalWriteOrder})!==prepared.proposalSha256)throw Error('supporting_projection: proposal integrity mismatch');
 const a=approval as any;if(a?.approved!==true||a.proposalSha256!==prepared.proposalSha256)throw Error('supporting_projection: independent role/source approval missing');
 const value={...structuredClone(prepared),scope:{...scope},reviewed:true as const};return{...value,sha256:hash(value)};
}
export function supportingText(seal:unknown,scope:SupportingScope):string{
 if(seal===undefined||seal===null)return'';
 const {sha256,...value}=seal as SupportingSeal;
 if(value.protocol!==SUPPORTING_PROTOCOL||value.reviewed!==true||value.scope?.owner!==scope.owner||value.scope?.appId!==scope.appId||hash(value)!==sha256)throw Error('supporting_projection: sealed scope/integrity mismatch');
 // Re-derive all source bindings from the complete persisted business receipts.
 const rebuilt=prepareSupportingSections(value.sections,value.sources,value.lastExternalWriteOrder,value.lastLocalWriteOrder);
 if(rebuilt.proposalSha256!==value.proposalSha256)throw Error('supporting_projection: sealed source mismatch');
 return value.sections.map(s=>[s.title+':',...s.rows.map(r=>'• '+[r.name,r.detail].filter(v=>v!==undefined).join('\n'))].join('\n\n')).join('\n\n');
}
export const supportingProjectionPolicy='The host offers optional readonly supportingSections distinct from primary entities. Use catalog_options for actual available choices and supporting_results for actual requested secondary results alongside the main tracked units. Do not insert directory choices or secondary feed rows into primary entities merely to make them visible. For done JSON you may return supportingSections:[{role:"catalog_options"|"supporting_results",title:string,rows:[{name:string,id?:string,detail?:string}]}]. Copy each name and optional detail as one complete exact string from actual current read evidence (external GET or authenticated owner/app app-state read/list); preserve a real ID only from that same source object. No pointers, source claims, actions, fabricated labels, paraphrased values or receipt metadata in rows. The host derives exact unique source bindings, rejecting ambiguity or pre-write stale evidence. Roles are proposals: the independent evaluator must compare original/current need and full actual sources, not infer semantic types from API names. Supporting sections are readonly display, never saved membership, primary row actions, write authority or evidence of external success. Keep actual untouched saved members and all primary readback/full-goal gates unchanged. Omitted required secondary results still make the whole goal incomplete. An enabled typed protocol is not permission to downgrade saved primary members to a supporting section.';

/** Narrow removal exception: only the actual scoped local delete and a later
 * separate exact-null read can establish removal; a model policy alone cannot. */
export function approvedLocalPrimaryRemoval(recordId:unknown,calls:any[],approval:any):boolean{
 if(typeof recordId!=='string'||!recordId||approval?.approved!==true||!Array.isArray(approval.authorizedDeletedAppRecordIds)||!approval.authorizedDeletedAppRecordIds.includes(recordId))return false;
 const actual=(c:any)=>c.source==='app-state'&&c.ok===true&&c.executionState==='succeeded'&&c.requestSource==='host-bound-app-state-dispatched-arguments'&&c.response?.source==='app-state'&&c.response?.scope==='authenticated-current-owner-app'&&c.response?.persisted===true&&Number.isSafeInteger(c.order);
 const mutations=calls.filter(c=>actual(c)&&['app_state.upsert_record','app_state.delete_record'].includes(c.api)&&c.request?.recordId===recordId).sort((a,b)=>b.order-a.order);const d=mutations[0];
 if(d?.api!=='app_state.delete_record'||d.response.operation!=='delete-and-read-back'||d.response.recordId!==recordId||d.response.deleted!==true||d.response.deletedRecordKind!=='primary_member')return false;
 return calls.some(c=>actual(c)&&c.api==='app_state.read_record'&&c.request?.recordId===recordId&&c.order>d.order&&c.response.operation==='read'&&c.response.record===null);
}
