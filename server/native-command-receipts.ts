import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {hostNativeActionNotStartedProof,validateNativeActionNotStartedProof,nativeActionPayloadSha256,normalizeNativeActionId} from './native-action-not-started.js';
import {requireActionRequestId,actionRequestConflict,completedActionReceipt,type NativeActionReceipt} from './native-action-request.js';
export type CommandReceiptBinding={actionId:string;owner:string;appId:string;requestId:string;command?:string;eventPayload:unknown};
type Receipt={admitted:boolean;requestId:string;state:'running'|'executing'|'completed'|'failed'|'unknown';response?:NativeActionReceipt};
export class NativeCommandReceipts {
 constructor(private db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS native_host_command_receipts(
 owner TEXT NOT NULL,app_id TEXT NOT NULL,request_id TEXT NOT NULL,command_sha TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','executing','completed','failed','unknown')),response_json TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,action_id TEXT,event_payload_sha256 TEXT,execution_id TEXT,PRIMARY KEY(owner,app_id,request_id));`);
 const columns=(db.prepare('PRAGMA table_info(native_host_command_receipts)').all() as Array<{name:string}>).map(c=>c.name);
 for(const column of ['action_id','event_payload_sha256','execution_id'])if(!columns.includes(column))db.exec(`ALTER TABLE native_host_command_receipts ADD COLUMN ${column} TEXT`);
 }
 lookup(b:Pick<CommandReceiptBinding,'owner'|'appId'|'requestId'>){return this.db.prepare('SELECT * FROM native_host_command_receipts WHERE owner=? AND app_id=? AND request_id=?').get(b.owner,b.appId,requireActionRequestId(b.requestId)) as any;}
 assertAppResolved(owner:string,appId:string){if(this.db.prepare("SELECT 1 FROM native_host_command_receipts WHERE owner=? AND app_id=? AND state IN ('running','executing','unknown') LIMIT 1").get(owner,appId))throw Object.assign(Error('native_command_unresolved: prior execution may have effects; inspect evidence before another action; automatic retry forbidden'),{status:409,code:'action_request_unresolved'});}
 private assertBinding(old:any,b:CommandReceiptBinding){if(!old||old.action_id!==normalizeNativeActionId(b.actionId)||old.event_payload_sha256!==nativeActionPayloadSha256(b.eventPayload))return actionRequestConflict('Request id is unbound or already bound to a different action/payload; no operation was repeated.');}
 prior(b:CommandReceiptBinding):Receipt|undefined{const old=this.lookup(b);if(!old)return undefined;this.assertBinding(old,b);return {admitted:false,requestId:requireActionRequestId(b.requestId),state:old.state,...(old.state==='completed'?{response:completedActionReceipt(b,old.execution_id)}:{})};}
 begin(b:CommandReceiptBinding):Receipt {
  const requestId=requireActionRequestId(b.requestId);if(!b.owner||!b.appId||!b.actionId.trim())throw Error('invalid receipt binding');
  const digest=nativeActionPayloadSha256(b.eventPayload),actionId=normalizeNativeActionId(b.actionId);
  return this.db.transaction(()=>{const prior=this.prior(b);if(prior)return prior;
   this.assertAppResolved(b.owner,b.appId);const now=new Date().toISOString();
   this.db.prepare("INSERT INTO native_host_command_receipts(owner,app_id,request_id,command_sha,state,response_json,created_at,updated_at,action_id,event_payload_sha256,execution_id) VALUES(?,?,?,?, 'running',NULL,?,?,?,?,NULL)").run(b.owner,b.appId,requestId,createHash('sha256').update(b.command??JSON.stringify(b.eventPayload)).digest('hex'),now,now,actionId,digest);
   return {admitted:true,requestId,state:'running' as const};
  }).immediate();
 }
 enterExecutor(b:CommandReceiptBinding,executionId:string){if(!executionId||executionId.length>100)throw Error('actual execution id required');this.assertBinding(this.lookup(b),b);const r=this.db.prepare("UPDATE native_host_command_receipts SET state='executing',execution_id=?,updated_at=? WHERE owner=? AND app_id=? AND request_id=? AND state='running'").run(executionId,new Date().toISOString(),b.owner,b.appId,requireActionRequestId(b.requestId));if(r.changes!==1)throw Error('receipt executor entry is not current running request');}
 /** Must be called inside the SAME transaction as app state/audit persistence. */
 complete(b:CommandReceiptBinding){if(!this.db.inTransaction)throw Error('receipt completion must share the app state transaction');const old=this.lookup(b);this.assertBinding(old,b);const receipt=completedActionReceipt(b,old.execution_id);const r=this.db.prepare("UPDATE native_host_command_receipts SET state='completed',response_json=?,updated_at=? WHERE owner=? AND app_id=? AND request_id=? AND state='executing'").run(JSON.stringify(receipt),new Date().toISOString(),b.owner,b.appId,requireActionRequestId(b.requestId));if(r.changes!==1)throw Error('receipt completion is not current execution');return receipt;}
 fail(b:CommandReceiptBinding,error:unknown){const old=this.lookup(b);this.assertBinding(old,b);
  // An error after the commit boundary does not undo a real completed operation.
  if(old.state==='completed')return 'completed';
  if(!['running','executing'].includes(old.state))throw Error('cannot release a terminal or absent receipt');
  const proof=hostNativeActionNotStartedProof(error);const notStarted=old.state==='running'&&proof&&validateNativeActionNotStartedProof(proof,{appId:b.appId,actionId:b.actionId,eventPayload:b.eventPayload});
  const state=notStarted?'failed':'unknown';this.db.prepare('UPDATE native_host_command_receipts SET state=?,execution_id=COALESCE(execution_id,?),updated_at=? WHERE owner=? AND app_id=? AND request_id=?').run(state,notStarted?proof.executionId:null,new Date().toISOString(),b.owner,b.appId,requireActionRequestId(b.requestId));return state;
 }
}
