import type {AppRecordField} from './native-app-records.js';

export type GroundedEntity={name:string;id?:string;detail?:string;group?:string;appRecordId?:string};
const compact=(input:string,max:number)=>{const text=input.replace(/\s+/g,' ').trim();return text.length<=max?text:`${text.slice(0,max-1)}…`;};

/** Only current-turn host receipts from the owner/app-bound adapter are passed
 * here. This proves a local name association, never external business success. */
export function hasLocalReadNameBinding(entity:GroundedEntity,calls:Array<Record<string,any>>,fields:readonly AppRecordField[]):boolean{
 if(!entity.appRecordId)return false;
 const key=entity.appRecordId;
 const latestWrite=calls.filter(call=>call.source==='app-state'&&['app_state.upsert_record','app_state.delete_record'].includes(call.api)&&(call.request??call.attemptedArguments)?.recordId===key&&Number.isSafeInteger(call.order))
  .reduce((order,call)=>Math.max(order,call.order),-1);
 return calls.some(call=>{
  const response=call.response;
  if(call.source!=='app-state'||call.ok!==true||call.executionState!=='succeeded'||call.requestSource!=='host-bound-app-state-dispatched-arguments'
   ||!Number.isSafeInteger(call.order)||call.order<=latestWrite||!response||response.source!=='app-state'||response.scope!=='authenticated-current-owner-app'||response.persisted!==true)return false;
  const records=call.api==='app_state.read_record'&&response.operation==='read'&&call.request?.recordId===key?[response.record]
   :call.api==='app_state.list_records'&&response.operation==='list'&&Array.isArray(response.records)?response.records:[];
  return records.some((record:any)=>record?.recordId===key&&Number.isSafeInteger(record.revision)&&record.revision>0&&record.values&&typeof record.values==='object'&&!Array.isArray(record.values)
   &&fields.some(field=>field.type==='string'&&typeof record.values[field.name]==='string'&&record.values[field.name].trim()===entity.name));
 });
}

export function normalizeGroundingEntities(raw:unknown,formEchoes:ReadonlySet<string>,calls:Array<Record<string,any>>,fields:readonly AppRecordField[]):GroundedEntity[]{
 return (Array.isArray(raw)?raw:[])
  .filter((item:unknown)=>item&&typeof item==='object'&&String((item as Record<string,unknown>).name||'').trim())
  // Proof uses the full submitted name before presentation compaction.
  .filter((item:Record<string,unknown>)=>Boolean(item.id!==undefined&&item.id!==null&&String(item.id).trim())||!formEchoes.has(String(item.name).trim())||hasLocalReadNameBinding({name:String(item.name).trim(),...(typeof item.appRecordId==='string'?{appRecordId:item.appRecordId}:{})},calls,fields))
  .map((item:Record<string,unknown>)=>({
   name:compact(String(item.name),40),
   ...(item.id!==undefined&&item.id!==null&&String(item.id).trim()?{id:compact(String(item.id),24)}:{}),
   ...(typeof item.detail==='string'&&item.detail.trim()?{detail:compact(item.detail,80)}:{}),
   ...(typeof item.group==='string'&&item.group.trim()?{group:compact(item.group,24)}:{}),
   ...(typeof item.appRecordId==='string'&&item.appRecordId.trim()?{appRecordId:item.appRecordId}:{}),
  }));
}

/** Only the executor's current-turn, host-produced receipt log is accepted.
 * A guessed CAS revision or model-supplied provenance is not a read proof. */
export function hasLocalDeleteReadProof(recordId:unknown,revision:unknown,calls:Array<Record<string,any>>):boolean{
 if(typeof recordId!=='string'||!Number.isSafeInteger(revision)||Number(revision)<1)return false;
 const latestMutation=calls.filter(call=>call.source==='app-state'&&['app_state.upsert_record','app_state.delete_record'].includes(call.api)&&(call.request??call.attemptedArguments)?.recordId===recordId&&Number.isSafeInteger(call.order)).reduce((last,call)=>Math.max(last,call.order),-1);
 return calls.some(call=>{
  const response=call.response;
  if(call.source!=='app-state'||call.ok!==true||call.executionState!=='succeeded'||call.requestSource!=='host-bound-app-state-dispatched-arguments'||!Number.isSafeInteger(call.order)||call.order<=latestMutation||response?.source!=='app-state'||response.scope!=='authenticated-current-owner-app'||response.persisted!==true)return false;
  const records=call.api==='app_state.read_record'&&response.operation==='read'&&call.request?.recordId===recordId?[response.record]
   :call.api==='app_state.list_records'&&response.operation==='list'&&Array.isArray(response.records)?response.records:[];
  return records.some((record:any)=>record?.recordId===recordId&&record.revision===revision);
 });
}
