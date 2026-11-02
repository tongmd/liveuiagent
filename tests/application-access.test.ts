import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createApplicationAccess} from '../server/application-access.js';

function fixture(t:any){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE agent_apps(app_id TEXT PRIMARY KEY,owner TEXT,package_json TEXT,data_json TEXT,runtime_state_json TEXT,version TEXT);
 CREATE TABLE rich_workspaces(owner TEXT,app_id TEXT,snapshot_json TEXT,PRIMARY KEY(owner,app_id));
 CREATE TABLE complete_apps(owner TEXT,app_id TEXT,info_json TEXT,updated_at TEXT,PRIMARY KEY(owner,app_id));
 CREATE TABLE user_llm_settings(owner TEXT,secret TEXT);`);
 db.prepare('INSERT INTO user_llm_settings VALUES (?,?)').run('alice','private-provider-value');
 const native={manifest:{name:'Native',version:'1.2.3'},frontend:{files:{'App.tsx':'// '+('exact source 你好🌏\n'.repeat(5000))}}};
 const state={app:{id:'visual_one',name:'Chart',harness:'kimi'},version:4,tree:{type:'Text',text:'72'},records:[{id:'r',value:72}],interactionState:{checked:{r:true}},requestHistory:[{prompt:'keep all data'}]};
 const html={app:{id:'one',name:'HTML',revision:9},html:'<!doctype html><title>Saved</title>',store:{count:7}};
 for(const owner of ['alice','bob','']){
  const suffix=owner||'shared';db.prepare('INSERT INTO agent_apps VALUES (?,?,?,?,?,?)').run('native_'+suffix,owner,JSON.stringify(native),JSON.stringify({items:[{id:1,secretNote:'owned content'}]}),JSON.stringify({selected:1}),'1.2.3');
  db.prepare('INSERT INTO rich_workspaces VALUES (?,?,?)').run(owner,'visual_one',JSON.stringify(state));
  db.prepare('INSERT INTO complete_apps VALUES (?,?,?,?)').run(owner,'dsh_one',JSON.stringify(html.app),'today');
 }
 const calls:any[]=[];const access=createApplicationAccess(db,{harnessOf:(_o,id)=>id.startsWith('native_')?'qwen':undefined,htmlRead:async(owner,id)=>{calls.push({owner,id});return html;}});
 return {db,access,html,state,native,calls};
}

test('unified inventory spans three formats with explicit pagination and exact owner scope',t=>{
 const x=fixture(t),before=x.db.prepare('SELECT total_changes() n').get().n;
 const first=x.access.list('alice',{limit:2});assert.equal(first.total,3);assert.equal(first.nextOffset,2);assert.equal(first.apps.length,2);
 const all=[...first.apps,...x.access.list('alice',{offset:2,limit:2}).apps];assert.deepEqual(all.map(a=>a.format).sort(),['html','native','workspace']);
 assert.equal(all.find(a=>a.format==='native')?.harness,'qwen');assert.equal(all.find(a=>a.format==='workspace')?.version,4);
 assert.ok(!JSON.stringify(all).includes('native_bob'));assert.ok(!JSON.stringify(all).includes('private-provider-value'));assert.equal(x.calls.length,0);assert.equal(x.db.prepare('SELECT total_changes() n').get().n,before);
});

test('native exact source paging reconstructs all Unicode and source bytes, snapshots detached',async t=>{
 const x=fixture(t);let result=await x.access.read('alice','native_alice',{section:'source',maxChars:997});const token=result.token;let combined=result.content;
 while(result.nextOffset!==null){result=await x.access.read('alice','native_alice',{section:'source',maxChars:997,offset:result.nextOffset,expectedToken:token});combined+=result.content;}
 assert.deepEqual(JSON.parse(combined),x.native);assert.equal(result.sha256,createHash('sha256').update(combined).digest('hex'));assert.equal(combined.length,result.totalChars);
 const snap=await x.access.snapshot('alice','native_alice');snap.content.data.items[0].id=99;assert.equal((await x.access.snapshot('alice','native_alice')).content.data.items[0].id,1);
});

test('reads complete rich tree, records and interaction state; no write or inference',async t=>{
 const x=fixture(t),before=x.db.prepare('SELECT snapshot_json FROM rich_workspaces WHERE owner=?').get('alice');
 const snapshot=await x.access.snapshot('alice','visual_one');assert.deepEqual(snapshot.content,x.state);
 for(const [section,expected] of [['source',x.state.tree],['records',x.state.records],['state',x.state.interactionState]] as const)assert.deepEqual(JSON.parse((await x.access.read('alice','visual_one',{section})).content),expected);
 assert.deepEqual(x.db.prepare('SELECT snapshot_json FROM rich_workspaces WHERE owner=?').get('alice'),before);
});

test('HTML reader must return actual source and store; callback is owner scoped and result detached',async t=>{
 const x=fixture(t),s=await x.access.snapshot('alice','dsh_one');assert.deepEqual(s.content,x.html);assert.deepEqual(x.calls,[{owner:'alice',id:'dsh_one'}]);
 s.content.store.count=500;assert.equal(x.html.store.count,7);
 assert.equal(JSON.parse((await x.access.read('alice','dsh_one',{section:'source'})).content),x.html.html);
 const absent=createApplicationAccess(x.db);await assert.rejects(absent.snapshot('alice','dsh_one'),{code:'application_content_unavailable'});
 const incomplete=createApplicationAccess(x.db,{htmlRead:async()=>({app:x.html.app} as any)});await assert.rejects(incomplete.snapshot('alice','dsh_one'),{code:'application_content_incomplete'});
 const wrong=createApplicationAccess(x.db,{htmlRead:async()=>({...x.html,app:{id:'other'}})});await assert.rejects(wrong.snapshot('alice','dsh_one'),{code:'application_identity_mismatch'});
});

test('owner isolation, authentication and explicit shared-native opt-in never expose private app',async t=>{
 const x=fixture(t);assert.throws(()=>x.access.list(''),{status:401});assert.throws(()=>x.access.list(' alice'),{status:401});
 await assert.rejects(x.access.snapshot('alice','native_bob'),{status:404});await assert.rejects(x.access.snapshot('alice','native_shared'),{status:404});
 const shared=createApplicationAccess(x.db,{includeSharedNative:true});assert.equal(shared.list('alice').total,4);await assert.rejects(shared.snapshot('alice','native_bob'),{status:404});
 x.db.prepare('DELETE FROM complete_apps WHERE owner=?').run('alice');await assert.rejects(x.access.snapshot('alice','dsh_one'),{status:404});assert.equal(x.calls.length,0);
});

test('tokens bind complete data and harness; stale reads reject instead of mixing versions',async t=>{
 const x=fixture(t),initial=await x.access.snapshot('alice','visual_one');
 x.state.interactionState.checked.r=false;x.db.prepare('UPDATE rich_workspaces SET snapshot_json=? WHERE owner=?').run(JSON.stringify(x.state),'alice');
 await assert.rejects(x.access.read('alice','visual_one',{expectedToken:initial.token}),{status:409,code:'application_conflict'});
 const updated=await x.access.snapshot('alice','visual_one');assert.notEqual(updated.token,initial.token);
 const alternate=createApplicationAccess(x.db,{harnessOf:()=> 'codex'});assert.notEqual((await alternate.snapshot('alice','visual_one')).token,updated.token);
});

test('page bounds and missing sections fail explicitly; no silent field omissions',async t=>{
 const x=fixture(t);assert.throws(()=>x.access.list('alice',{limit:0}),{status:400});assert.throws(()=>x.access.list('alice',{offset:-1}),{status:400});
 await assert.rejects(x.access.read('alice','visual_one',{section:'arbitrary' as any}),{status:400});await assert.rejects(x.access.read('alice','visual_one',{maxChars:32001}),{status:400});
 await assert.rejects(x.access.read('alice','visual_one',{offset:999999999}),{status:400});
 delete (x.state as any).records;x.db.prepare('UPDATE rich_workspaces SET snapshot_json=? WHERE owner=?').run(JSON.stringify(x.state),'alice');await assert.rejects(x.access.read('alice','visual_one',{section:'records'}),{code:'application_content_incomplete'});
});


test('all six harness identities share exact app read permissions and content',async t=>{
 const x=fixture(t);let baseline:unknown;
 for(const harness of ['native','dsh','codex','qwen','kimi','zcode']){
  const access=createApplicationAccess(x.db,{harnessOf:()=>harness,htmlRead:async()=>x.html});
  const apps=access.list('alice');assert.equal(apps.total,3);assert.ok(apps.apps.every(a=>a.harness===harness));
  const content=await Promise.all(apps.apps.map(async a=>(await access.snapshot('alice',a.appId)).content));
  if(baseline)assert.deepEqual(content,baseline);else baseline=content;
  await assert.rejects(access.snapshot('alice','native_bob'),{status:404});
 }
});
