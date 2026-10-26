import {GuiBusinessEpochs,requireGuiEpochAutocommit} from './gui-business-epoch.js';
import type Database from 'better-sqlite3';
import {createNativeAppRecords, type AppRecord, type AppRecordField,type AppRecordReadKind} from './native-app-records.js';
export type AppStateCapability={id:string;apiName:string;source:'app-state';appName:'app-state';method:'GET'|'POST'|'DELETE';requiredParams:string[];inputSchema:unknown;purpose:string};
export type AppStateAdapter={capabilities:AppStateCapability[];recordFields:readonly AppRecordField[];call(api:string,args:Record<string,unknown>):unknown;listAll(recordKind:AppRecordReadKind):AppRecord[]};
export function appRecordFields(fields:any[]):AppRecordField[]{return fields.filter(f=>f&&typeof f.name==='string'&&!f.hiddenInForm&&!['id','prompt','context','state','nextStep','result'].includes(f.name)).map(f=>({name:f.name,type:['number','integer','stepper','currency'].includes(f.type)?'number':['boolean','toggle','switch'].includes(f.type)?'boolean':'string',...(Array.isArray(f.options)?{options:f.options.map((o:any)=>({value:String(o.value)}))}:{})}));}
export function appStateCapabilitySchemas(fields:AppRecordField[],permissions:string[]):AppStateCapability[]{
 if(!permissions.includes('storage.app'))return [];
 const canWrite=permissions.includes('app_state.write');
 const properties=Object.fromEntries(fields.map(f=>[f.name,{type:[f.type,'null'],...(f.options?.length?{enum:[...f.options.map(o=>o.value),null]}:{})}]));
 return [
  {id:'app_state.read_record',apiName:'app_state.read_record',source:'app-state',appName:'app-state',method:'GET',requiredParams:['recordId'],inputSchema:{type:'object',properties:{recordId:{type:'string'}},additionalProperties:false},purpose:'Read an actual app-local record. This is NOT an external service object.'},
  {id:'app_state.list_records',apiName:'app_state.list_records',source:'app-state',appName:'app-state',method:'GET',requiredParams:['recordKind'],inputSchema:{type:'object',required:['recordKind'],properties:{recordKind:{type:'string',enum:['primary_member','supporting_preference','unknown']},offset:{type:'integer'},limit:{type:'integer',maximum:100}},additionalProperties:false},purpose:'Read an explicit kind via actual owner/app SQL filtering with pagination and actual unknownRecordCount. Unknown legacy rows cannot prove membership or a complete empty primary collection. Declared local inputs/domain state are separate from external business data.'},
  ...(canWrite?[{id:'app_state.upsert_record',apiName:'app_state.upsert_record',source:'app-state' as const,appName:'app-state' as const,method:'POST' as const,requiredParams:['recordId','recordKind','values'],inputSchema:{type:'object',required:['recordId','recordKind','values'],properties:{recordKind:{type:'string',enum:['primary_member','supporting_preference']},recordId:{type:'string'},values:{type:'object',properties,additionalProperties:false}},additionalProperties:false},purpose:'Persist an explicit primary_member or supporting_preference kind with declared app-local fields; unknown legacy rows and ordinary kind flips are rejected. Classification follows the original need, never external truth. Persist only declared app-local input/domain-state fields for a stable recordId; values never substitute for required external service writes. Read back afterwards. To attach persisted metadata to a primary row, return its exact appRecordId in entities.'},{id:'app_state.delete_record',apiName:'app_state.delete_record',source:'app-state' as const,appName:'app-state' as const,method:'DELETE' as const,requiredParams:['recordId','expectedRevision'],inputSchema:{type:'object',properties:{recordId:{type:'string'},expectedRevision:{type:'integer',minimum:1}},additionalProperties:false},purpose:'Delete exactly one requested owner/app-local record using its actual read revision, then verify absence with read/list. Not an external service delete. Missing records report not_found; revision conflicts require a fresh decision, never automatic retry.'}]:[]),
 ] satisfies AppStateCapability[];
}
export function createAppStateAdapter(db:Database.Database,owner:string,appId:string,fields:AppRecordField[],permissions:string[]):AppStateAdapter|undefined{
 if(!owner||!permissions.includes('storage.app'))return undefined;
 if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');
 requireGuiEpochAutocommit(db);const store=createNativeAppRecords(db,owner,appId,fields);const guiBusinessEpochs=new GuiBusinessEpochs(db);
 const capabilities=appStateCapabilitySchemas(fields,permissions);
 return{capabilities,recordFields:fields.map(field=>({...field})),call(api,args){if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');if(!capabilities.some(c=>c.apiName===api))throw Error('Unauthorized app-state capability');const allowed=api==='app_state.list_records'?['recordKind','offset','limit']:api==='app_state.read_record'?['recordId']:api==='app_state.delete_record'?['recordId','expectedRevision']:['recordId','recordKind','values'];if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('App-state arguments cannot select another owner/app or undeclared scope');if(api==='app_state.upsert_record'||api==='app_state.delete_record')guiBusinessEpochs.advance(owner,appId);if(api==='app_state.read_record')return store.readRecord(args.recordId);if(api==='app_state.list_records')return store.listRecords(args.recordKind,args.offset as number|undefined,args.limit as number|undefined);if(api==='app_state.delete_record')return store.deleteRecord(args.recordId,args.expectedRevision);return store.upsertRecord(args.recordId,args.recordKind,args.values);},listAll(recordKind){if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');const records:AppRecord[]=[];for(let offset=0;;offset+=100){const page=store.listRecords(recordKind,offset,100).records as AppRecord[];records.push(...page);if(page.length<100)return records;}}};

}
// Reopen reads the real store. Only an explicit verified association attaches
// metadata to an existing row; records never invent primary rows or service facts.
export function hydrateAppState(stored:any,adapter:AppStateAdapter|undefined){
 if(!adapter)return stored;
 const records=adapter.listAll('primary_member');stored.runtimeState.appRecords=records;stored.runtimeState.appPreferences=adapter.listAll('supporting_preference');stored.runtimeState.unclassifiedAppRecords=adapter.listAll('unknown');
 stored.runtimeState.entities=(Array.isArray(stored.runtimeState.entities)?stored.runtimeState.entities:[]).map((row:any)=>{const record=typeof row.appRecordId==='string'?records.find(r=>r.recordId===row.appRecordId):undefined;const {appState:_,...withoutStale}=row;return record?{...withoutStale,appState:record.values}:withoutStale;});
 return stored;
}

/** Initial projection can inspect the same owner/app store but never gains write capability. */
export function createInitialAppStateAdapter(db:Database.Database,owner:string,appId:string,fields:AppRecordField[],permissions:unknown):AppStateAdapter|undefined{
 return createAppStateAdapter(db,owner,appId,fields,Array.isArray(permissions)&&permissions.includes('storage.app')?['storage.app']:[]);
}
