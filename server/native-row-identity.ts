import type Database from 'better-sqlite3';
import {appRecordIdentity} from './opaque-identity.js';
/** A local row key is scoped SQLite identity, never an external-service identifier. */
export function assertLocalRowRecordIdentity(db:Database.Database,input:{owner:string;appId:string;appRecordId:unknown;name:string;fields:readonly{name:string;type:string}[]}){
 const recordId=appRecordIdentity(input.appRecordId);if(!recordId)return;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_app_records'").get())throw Error('Row app record is not a current owner/app record');
 const row=db.prepare('SELECT record_kind,values_json FROM native_app_records WHERE owner=? AND app_id=? AND record_id=?').get(input.owner,input.appId,recordId) as {record_kind:string;values_json:string}|undefined;
 if(!row||row.record_kind!=='primary_member')throw Error('Row app record is not a current owner/app primary member');
 const values=JSON.parse(row.values_json);
 if(!input.fields.some(field=>field.type==='string'&&typeof values[field.name]==='string'&&values[field.name]===input.name))throw Error('Row app record name does not match a declared persisted string field');
}
