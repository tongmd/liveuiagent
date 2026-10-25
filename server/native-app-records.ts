import type Database from 'better-sqlite3';
import {remainingActionMs} from './action-deadline.js';

export type AppRecordField={name:string;type:string;options?:Array<{value:string}>};
export type AppRecord={recordId:string;values:Record<string,string|number|boolean|null>;revision:number;updatedAt:string};
/** The host binds this store after authentication. Model arguments never select a scope. */
export function createNativeAppRecords(db:Database.Database,owner:string,appId:string,fields:AppRecordField[]){
 if(!owner||!appId)throw Error('App records require an authenticated owner and app');
 const schema=new Map(fields.map(f=>[f.name,f]));
 if(schema.size!==fields.length||schema.size>64)throw Error('Invalid app record field schema');
 db.exec(`CREATE TABLE IF NOT EXISTS native_app_records(owner TEXT NOT NULL,app_id TEXT NOT NULL,record_id TEXT NOT NULL,values_json TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,app_id,record_id))`);
 const scope=()=>{remainingActionMs();if(!db.prepare('SELECT 1 FROM agent_apps WHERE app_id=? AND owner=?').get(appId,owner))throw Error('App records scope is unavailable');};
 const id=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>160||/[\u0000-\u001f]/.test(value))throw Error('Invalid app record identity');return value;};
 const decode=(row:any):AppRecord|undefined=>row?{recordId:row.record_id,values:JSON.parse(row.values_json),revision:row.revision,updatedAt:row.updated_at}:undefined;
 const read=(recordId:string)=>decode(db.prepare('SELECT record_id,values_json,revision,updated_at FROM native_app_records WHERE owner=? AND app_id=? AND record_id=?').get(owner,appId,recordId));
 const recordEvidence=(operation:string,record:AppRecord|null)=>({source:'app-state' as const,operation,scope:'authenticated-current-owner-app' as const,persisted:true,record});
 return {
  readRecord(recordId:unknown){scope();return recordEvidence('read',read(id(recordId))??null);},
  listRecords(offset=0,limit=50){scope();if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid app record pagination');return{source:'app-state' as const,operation:'list',scope:'authenticated-current-owner-app' as const,persisted:true,offset,limit,records:db.prepare('SELECT record_id,values_json,revision,updated_at FROM native_app_records WHERE owner=? AND app_id=? ORDER BY record_id LIMIT ? OFFSET ?').all(owner,appId,limit,offset).map(decode)};},
  upsertRecord(recordId:unknown,patch:unknown){
   scope();const key=id(recordId);
   if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('App record values must be a field object');
   const entries=Object.entries(patch);if(!entries.length||entries.length>64)throw Error('Invalid app record patch size');
   for(const [name,value]of entries){
    const field=schema.get(name);if(!field||['__proto__','constructor','prototype'].includes(name))throw Error('Undeclared app record field: '+name);
    if(value===null)continue;
    if(field.type==='number'?typeof value!=='number'||!Number.isFinite(value):field.type==='boolean'||field.type==='toggle'?typeof value!=='boolean':typeof value!=='string'||value.length>12000)throw Error('Invalid value for app record field: '+name);
    if(field.options?.length&&!field.options.some(o=>o.value===value))throw Error('Unavailable app record option: '+name);
   }
   if(Buffer.byteLength(JSON.stringify(patch))>65536)throw Error('App record patch exceeds byte limit');
   return db.transaction(()=>{
    scope();const previous=read(key);const values={...(previous?.values??{}),...patch as AppRecord['values']};const revision=(previous?.revision??0)+1;const updatedAt=new Date().toISOString();
    db.prepare(`INSERT INTO native_app_records(owner,app_id,record_id,values_json,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,app_id,record_id) DO UPDATE SET values_json=excluded.values_json,revision=excluded.revision,updated_at=excluded.updated_at`).run(owner,appId,key,JSON.stringify(values),revision,updatedAt);
    remainingActionMs();const observed=read(key);if(!observed||observed.revision!==revision||JSON.stringify(observed.values)!==JSON.stringify(values))throw Error('App record persistence read-back mismatch');
    return recordEvidence('upsert-and-read-back',observed);
   })();
  },
 };
}
