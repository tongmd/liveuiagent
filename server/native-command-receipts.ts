import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import {hostNativeActionNotStartedProof,validateNativeActionNotStartedProof} from './native-action-not-started.js';
export type CommandReceiptBinding={actionId?:string;owner:string;appId:string;requestId:string;command:string;eventPayload:unknown};
type Receipt={admitted:boolean;requestId:string;state:'running'|'executing'|'completed'|'failed'|'unknown';response?:unknown};
export class NativeCommandReceipts {
 constructor(private db:Database.Database){db.exec(`CREATE TABLE IF NOT EXISTS native_host_command_receipts(
 owner TEXT NOT NULL,app_id TEXT NOT NULL,request_id TEXT NOT NULL,command_sha TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','executing','completed','failed','unknown')),response_json TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,app_id,request_id));`);}
 lookup(b:Pick<CommandReceiptBinding,'owner'|'appId'|'requestId'>){return this.db.prepare('SELECT * FROM native_host_command_receipts WHERE owner=? AND app_id=? AND request_id=?').get(b.owner,b.appId,b.requestId) as any;}
 assertAppResolved(owner:string,appId:string){
  if(this.db.prepare("SELECT 1 FROM native_host_command_receipts WHERE owner=? AND app_id=? AND state IN ('running','executing','unknown') LIMIT 1").get(owner,appId))throw Error('native_command_unresolved: prior execution may have effects; inspect evidence before another action; automatic retry forbidden');
 }
 begin(b:CommandReceiptBinding):Receipt {
  if(!b.owner||!b.appId||!b.requestId||!b.command.trim())throw Error('invalid receipt binding');
  const digest=createHash('sha256').update(b.command).digest('hex');
  return this.db.transaction(()=>{
   const old=this.lookup(b);if(old){if(old.command_sha!==digest)throw Error('request id already bound to different command');return {admitted:false,requestId:b.requestId,state:old.state,...(old.response_json?{response:JSON.parse(old.response_json)}:{})};}
   this.assertAppResolved(b.owner,b.appId);
   const now=new Date().toISOString();this.db.prepare("INSERT INTO native_host_command_receipts VALUES(?,?,?,?, 'running',NULL,?,?)").run(b.owner,b.appId,b.requestId,digest,now,now);
   return {admitted:true,requestId:b.requestId,state:'running'};
  })();
 }
 enterExecutor(b:CommandReceiptBinding){const result=this.db.prepare("UPDATE native_host_command_receipts SET state='executing',updated_at=? WHERE owner=? AND app_id=? AND request_id=? AND state='running'").run(new Date().toISOString(),b.owner,b.appId,b.requestId);if(result.changes!==1)throw Error('receipt executor entry is not current running request');}
 complete(b:CommandReceiptBinding,response:unknown){const json=JSON.stringify(response);if(json===undefined)throw Error('response required');const r=this.db.prepare("UPDATE native_host_command_receipts SET state='completed',response_json=?,updated_at=? WHERE owner=? AND app_id=? AND request_id=? AND state='executing'").run(json,new Date().toISOString(),b.owner,b.appId,b.requestId);if(r.changes!==1)throw Error('receipt completion is not current execution');}
 fail(b:CommandReceiptBinding,error:unknown){
  const old=this.lookup(b);if(!old||!['running','executing'].includes(old.state))throw Error('cannot release a terminal or absent receipt');
  const proof=hostNativeActionNotStartedProof(error);
  // Only the original host-marked object can release a pre-executor request.
  // Serialized fields/model claims and proofs for a previous request never unlock it.
  const notStarted=old.state==='running'&&proof&&validateNativeActionNotStartedProof(proof,{appId:b.appId,actionId:b.actionId??'host.app.command',eventPayload:b.eventPayload});
  const state=notStarted?'failed':'unknown';
  this.db.prepare('UPDATE native_host_command_receipts SET state=?,updated_at=? WHERE owner=? AND app_id=? AND request_id=?').run(state,new Date().toISOString(),b.owner,b.appId,b.requestId);
  return state;
 }
}
