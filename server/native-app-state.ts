import type Database from 'better-sqlite3';
import {createNativeAppRecords, type AppRecord, type AppRecordField} from './native-app-records.js';
export type AppStateCapability={id:string;apiName:string;source:'app-state';appName:'app-state';method:'GET'|'POST';requiredParams:string[];inputSchema:unknown;purpose:string};
export type AppStateAdapter={capabilities:AppStateCapability[];recordFields:readonly AppRecordField[];call(api:string,args:Record<string,unknown>):unknown;listAll():AppRecord[]};
export function appRecordFields(fields:any[]):AppRecordField[]{return fields.filter(f=>f&&typeof f.name==='string'&&!f.hiddenInForm&&!['id','prompt','context','state','nextStep','result'].includes(f.name)).map(f=>({name:f.name,type:['number','integer','stepper','currency'].includes(f.type)?'number':['boolean','toggle','switch'].includes(f.type)?'boolean':'string',...(Array.isArray(f.options)?{options:f.options.map((o:any)=>({value:String(o.value)}))}:{})}));}
export function createAppStateAdapter(db:Database.Database,owner:string,appId:string,fields:AppRecordField[],permissions:string[]):AppStateAdapter|undefined{
 if(!owner||!permissions.includes('storage.app'))return undefined;
 if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');
 const store=createNativeAppRecords(db,owner,appId,fields);const canWrite=permissions.includes('app_state.write');
 const properties=Object.fromEntries(fields.map(f=>[f.name,{type:[f.type,'null'],...(f.options?.length?{enum:[...f.options.map(o=>o.value),null]}:{})}]));
 const capabilities:AppStateCapability[]=[
  {id:'app_state.read_record',apiName:'app_state.read_record',source:'app-state',appName:'app-state',method:'GET',requiredParams:['recordId'],inputSchema:{type:'object',properties:{recordId:{type:'string'}},additionalProperties:false},purpose:'Read an actual app-local record. This is NOT an external service object.'},
  {id:'app_state.list_records',apiName:'app_state.list_records',source:'app-state',appName:'app-state',method:'GET',requiredParams:[],inputSchema:{type:'object',properties:{offset:{type:'integer'},limit:{type:'integer',maximum:100}},additionalProperties:false},purpose:'Read actual owner/app-local records with pagination. Local preferences/targets are separate from external business data.'},
  ...(canWrite?[{id:'app_state.upsert_record',apiName:'app_state.upsert_record',source:'app-state' as const,appName:'app-state' as const,method:'POST' as const,requiredParams:['recordId','values'],inputSchema:{type:'object',properties:{recordId:{type:'string'},values:{type:'object',properties,additionalProperties:false}},additionalProperties:false},purpose:'Persist only declared app-local preference/target fields for a stable recordId; values never substitute for required external service writes. Read back afterwards. To attach persisted metadata to a primary row, return its exact appRecordId in entities.'}]:[]),
 ];
 return{capabilities,recordFields:fields.map(field=>({...field})),call(api,args){if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');if(!capabilities.some(c=>c.apiName===api))throw Error('Unauthorized app-state capability');const allowed=api==='app_state.list_records'?['offset','limit']:api==='app_state.read_record'?['recordId']:['recordId','values'];if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('App-state arguments cannot select another owner/app or undeclared scope');if(api==='app_state.read_record')return store.readRecord(args.recordId);if(api==='app_state.list_records')return store.listRecords(args.offset as number|undefined,args.limit as number|undefined);return store.upsertRecord(args.recordId,args.values);},listAll(){if(db.inTransaction)throw Error('App-state persistence requires an autocommit scope, not an outer transaction');const records:AppRecord[]=[];for(let offset=0;;offset+=100){const page=store.listRecords(offset,100).records as AppRecord[];records.push(...page);if(page.length<100)return records;}}};
}
// Reopen reads the real store. Only an explicit verified association attaches
// metadata to an existing row; records never invent primary rows or service facts.
export function hydrateAppState(stored:any,adapter:AppStateAdapter|undefined){
 if(!adapter)return stored;
 const records=adapter.listAll();stored.runtimeState.appRecords=records;
 stored.runtimeState.entities=(Array.isArray(stored.runtimeState.entities)?stored.runtimeState.entities:[]).map((row:any)=>{const record=typeof row.appRecordId==='string'?records.find(r=>r.recordId===row.appRecordId):undefined;const {appState:_,...withoutStale}=row;return record?{...withoutStale,appState:record.values}:withoutStale;});
 return stored;
}
