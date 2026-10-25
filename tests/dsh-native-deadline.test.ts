import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {withActionDeadline,remainingActionMs,actionRetryDelay} from '../server/action-deadline.js';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function setup(t:any,decision:(step:number,system:string)=>any){
 let step=0;const requests:string[]=[];const calls:any[]=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const system=body.messages[0].content;requests.push(system);let value:any;
 if(system.includes('You analyze a GUI'))value={objective:'Update the record',deliverables:['A current record'],expectedNumbers:[]};
 else if(system.includes('You are the Write Verifier'))value={approved:true};
 else if(system.includes('INDEPENDENT evaluator'))value={pass:true,deficiencies:[]};
 else value=await decision(++step,system);
 if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const tools=[{id:'write',apiName:'update_note',permission:'write',appName:'simple_note',method:'PATCH',purpose:'Update actual record'},{id:'read',apiName:'read_notes',permission:'read',appName:'simple_note',method:'GET',purpose:'Read actual records'}];
 const bridge:any={getClock:async()=>null,getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{calls.push(id);return{tool:tools.find(t=>t.id===id),request:args,response:{id:'real',name:'Actual record'},dbChanges:null}}};
 const input:any={bridge,permissions:['write','read'],payload:{request:'Update the actual record',deadlineAt:'client cannot override'},appName:'Records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}};
 return{input,calls,requests};
}
test('trusted absolute budget aborts a slow native decision without invoking its proposed write',async t=>{
 const {input,calls,requests}=await setup(t,async()=>{await wait(500);return{calls:[{api:'update_note',args:{id:'real'}}]}});
 const result=await withActionDeadline(Date.now()+180,()=>runAppWorldGrounding(input));
 assert.equal(result?.evaluation?.pass,false);assert.equal(result?.deadlineExceeded,true);assert.deepEqual(calls,[]);assert.equal(requests.length,2);assert.match(JSON.stringify(result?.attempts),/deadline|not verified/);
});
test('completed real write is retained after expiry, with no later read or automatic retry',async t=>{
 const {input,calls}=await setup(t,()=>({calls:[{api:'update_note',args:{id:'real'}},{api:'read_notes',args:{}}]}));
 const original=input.bridge.callTool;input.bridge.callTool=async(...args:any[])=>{const result=await original(...args);await wait(250);return result};
 const result=await withActionDeadline(Date.now()+180,()=>runAppWorldGrounding(input));
 assert.deepEqual(calls,['write']);assert.equal(result?.calls.length,1);assert.equal(result?.evaluation?.pass,false);assert.equal(result?.deadlineExceeded,true);assert.match(JSON.stringify(result?.evaluation),/read-back|not verified/);
});
test('budget-tail done and a permissive reviewer cannot waive post-write read-back',async t=>{
 const {input,calls}=await setup(t,step=>step===1?{calls:[{api:'update_note',args:{id:'real'}}]}:{done:true,summary:'Claimed current result',entities:[{name:'Actual record',id:'real'}],stats:[]});
 const result=await withActionDeadline(Date.now()+4000,()=>runAppWorldGrounding(input));
 assert.deepEqual(calls,['write']);assert.equal(result?.evaluation?.pass,false);assert.match(JSON.stringify(result?.evaluation),/read-back/);assert.equal(result?.entities.length,0,'unread post-write claims never become verified entities');
});
test('retry waits share the absolute deadline and an inherited budget cannot be extended',async()=>{
 const start=Date.now();await assert.rejects(withActionDeadline(start+60,()=>withActionDeadline(start+6000,async()=>{assert.ok(remainingActionMs(9999)<=60);await actionRetryDelay(1000);remainingActionMs()})),/deadline/);assert.ok(Date.now()-start<250);
});

test('real tool HTTP budget expires before a business write and never retries an uncertain mutation',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const {createAppWorldBridge}=await import('../server/appworld-bridge.js');let delayDb=250,posts=0;
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tool-deadline-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;let value:any;
 if(req.url==='/api_docs/app_descriptions')value=[{name:'simple_note',description:'Notes'}];
 else if(req.url==='/simple_note/openapi.json')value={paths:{'/notes':{post:{operationId:'create_note',description:'Create an actual note',responses:{'200':{description:'Created'}}}}}};
 else if(req.url==='/dbs'){await wait(delayDb);value={simple_note:'/tmp/world/simple_note.db'}}
 else if(req.url==='/dbs/save')value={saved:true};
 else if(req.url==='/simple_note/notes'){posts++;await wait(250);value={id:'real-write'}}
 else value={};if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 await fs.writeFile(path.join(root,'liveuiagent.config.json'),JSON.stringify({appworld:{enabled:true,apiBase:`http://127.0.0.1:${(server.address() as any).port}`,snapshotRoot:'snapshots',apps:['simple_note'],timeoutMs:2000}}));
 const bridge=createAppWorldBridge(root)!;await bridge.getCapabilities();
 await assert.rejects(withActionDeadline(Date.now()+100,()=>bridge.callTool('tool.appworld.simple_note.create_note',{})),/deadline|timed out/);assert.equal(posts,0,'expired snapshot preparation cannot start a mutation');
 delayDb=0;
 await assert.rejects(withActionDeadline(Date.now()+100,()=>bridge.callTool('tool.appworld.simple_note.create_note',{})),/deadline|timed out/);assert.equal(posts,1,'an uncertain in-flight write must not be retried');
});

test('host action budget starts before saved-app lookup and cannot be extended by client context',async t=>{
 const express=(await import('express')).default,Database=(await import('better-sqlite3')).default;
 const {createCompleteApps}=await import('../server/complete-apps.js');let actions=0;
 const upstream=express();upstream.get('/api/apps/:id',async(_q,r)=>{await wait(300);r.json({app:{name:'Actual app',revision:1}})});upstream.post('/api/apps/:id/action',(_q,r)=>{actions++;r.json({status:'done'})});
 const server=http.createServer(upstream);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const before=process.env.LIVEUIAGENT_DSH_API_BASE;process.env.LIVEUIAGENT_DSH_API_BASE=`http://127.0.0.1:${(server.address() as any).port}/api`;t.after(()=>before===undefined?delete process.env.LIVEUIAGENT_DSH_API_BASE:process.env.LIVEUIAGENT_DSH_API_BASE=before);
 const db=new Database(':memory:');t.after(()=>db.close());const host=createCompleteApps(db,{recall:()=>[]},()=> 'fixture-owner',()=>({model:'fixture'}),{actionTimeoutMs:100});
 const app=express();app.use(express.json());host.install(app);app.use((error:any,_q:any,r:any,_n:any)=>r.status(error.status||500).json({code:error.code,error:error.message,trace:error.trace}));
 const service=http.createServer(app);await new Promise<void>(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();return new Promise<void>(r=>service.close(()=>r()))});
 const response=await fetch(`http://127.0.0.1:${(service.address() as any).port}/agent/complete/apps/dsh_12345678-1234-1234-1234-123456789abc/action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'Update the actual record',deadlineAt:Date.now()+600000,context:{deadlineAt:Date.now()+600000}})});const result:any=await response.json();
 assert.equal(response.status,504);assert.equal(result.code,'action_deadline_exceeded');assert.match(result.error,/not verified|may already/);assert.equal(actions,0);assert.equal(db.prepare('SELECT count(*) AS n FROM complete_host_actions').get().n,1);
});
