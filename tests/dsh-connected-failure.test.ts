import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {createCompleteApps,createDshServiceBindings} from '../server/complete-apps.js';

async function serve(t:any,app:any){const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));return `http://127.0.0.1:${(server.address() as any).port}`;}
test('connected service with zero actual native API calls fails durably without invoking the DSH fallback',async t=>{
 const id='12345678-1234-1234-1234-123456789abc',appId='dsh_'+id;
 let upstreamActions=0,businessCalls=0,modelCalls=0;
 const upstream=express();upstream.use(express.json());upstream.get('/api/runtime-settings',(_q,r)=>r.json({model:'fixture'}));upstream.get('/api/apps/'+id,(_q,r)=>r.json({app:{id,name:'Reading shelves',description:'Track shelves in notes',revision:1,lastJobId:'generation'}}));upstream.post('/api/apps/'+id+'/action',(_q,r)=>{upstreamActions++;r.json({id:'fake',status:'done',result:{text:'Invented success'}})});
 const remote=await serve(t,upstream);
 const world=express();world.get('/api_docs/app_descriptions',(_q,r)=>r.json([{name:'simple_note',description:'Notes'}]));world.get('/simple_note/openapi.json',(_q,r)=>r.json({paths:{'/notes':{patch:{operationId:'update_note',description:'Update notes',responses:{'200':{description:'Updated'}}}}}}));world.use((_q,r)=>{businessCalls++;r.status(500).json({error:'Business execution must not occur in this fixture'})});const worldBase=await serve(t,world);
 const model=express();model.use(express.json());model.post('/v1/chat/completions',(_q,r)=>{modelCalls++;r.json({choices:[{message:{content:JSON.stringify({done:true,summary:'A model claim without execution',entities:[],stats:[]})}}]})});const modelBase=await serve(t,model);
 const values:any={LIVEUIAGENT_DSH_API_BASE:remote+'/api',APPWORLD_ENABLED:'true',APPWORLD_API_BASE:worldBase,LIVEUIAGENT_APPWORLD_GROUNDING:'on',LIVEUI_DSH_USER_PREFIX:undefined,LIVEUI_DSH_EMPTY_ACCOUNT_ROOT:undefined};const before:any={};for(const [k,v]of Object.entries(values)){before[k]=process.env[k];if(v===undefined)delete process.env[k];else process.env[k]=String(v);}t.after(()=>{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=String(v)}});
 const db=new Database(':memory:');t.after(()=>db.close());createDshServiceBindings(db).save('alice',appId,'generation',{services:['simple_note'],permissions:['tool.appworld.simple_note.update_note']},'Edit actual notes',1);
 const bridge=createCompleteApps(db,{recall:()=>[]},req=>String(req.header('x-liveuiagent-user')||''),()=>({apiKey:'fixture-only',apiBase:modelBase+'/v1',model:'fixture'}));const app=express();app.use(express.json());bridge.install(app);app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message,code:e.code,trace:e.trace}));const base=await serve(t,app);
 const response=await fetch(base+'/agent/complete/apps/'+appId+'/action',{method:'POST',headers:{'Content-Type':'application/json','X-LiveUIAgent-User':'alice'},body:JSON.stringify({prompt:'Add the named book to the shelf'})});const result:any=await response.json();
 assert.equal(response.status,502);assert.equal(result.code,'dsh_tool_execution_empty');assert.equal(upstreamActions,0);assert.equal(businessCalls,0);assert.ok(modelCalls>=2,'actual native requirement and execution agents ran');
 const failed=await fetch(base+'/agent/complete/jobs/'+result.trace[0].jobId,{headers:{'X-LiveUIAgent-User':'alice'}}).then(r=>r.json()) as any;
 assert.equal(failed.status,'error');assert.equal(failed.code,'dsh_tool_execution_empty');assert.equal(failed.evidence,undefined);assert.deepEqual(failed.selectedServices,['simple_note']);
 assert.equal(db.prepare('SELECT count(*) AS n FROM complete_host_actions').get().n,1);
});
