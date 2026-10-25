import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createDshNativeInference} from '../server/dsh-native-inference.js';
import {independentInferencePair} from '../server/inference-pair.js';
import {persistNativeInferenceDiagnostic} from '../server/native-inference-diagnostics.js';
import {withActionDeadline} from '../server/action-deadline.js';
const request={model:'fixture-model',messages:[{role:'system',content:'private-prompt-never-save'},{role:'user',content:'Return JSON'}]};
async function setup(t:any,script:string,extra:any={},observe?:(event:any)=>void){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-capacity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {createCommandRunner}=await import('../packages/dsh-plugin/runner.mjs');
 const engine=path.join(root,'fixture-engine');await fs.writeFile(engine,'#!'+process.execPath+'\n'+script,{mode:0o700});
 const transport=createDshNativeInference({root:path.join(root,'workers'),diagnosticRoot:path.join(root,'diagnostics'),projectRoot:process.cwd(),command:process.execPath,maxConcurrent:1,timeoutMs:4000,runnerFactory:async()=>{const runner=createCommandRunner({command:engine,args:[],passEnv:[],isolatedHome:true});return{run:(input:any)=>runner.run({...input,onDiagnostic:(event:any)=>{input.onDiagnostic?.(event);observe?.(event);}}),dispose:()=>runner.dispose()};},...extra});
 t.after(()=>transport.dispose());return{root,transport,diagnostics:async()=>Promise.all((await fs.readdir(path.join(root,'diagnostics'))).filter(x=>x.endsWith('.json')).map(async name=>JSON.parse(await fs.readFile(path.join(root,'diagnostics',name),'utf8'))))};
}
const delayedFinal=`process.stdin.resume();setTimeout(()=>process.stdout.write(JSON.stringify({type:'final',text:'{"ok":true}'})+'\\n'),2200);`;
function assertGone(pid:number){assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');}
test('real capacity-one runner reproduces queue timeout, while lazy roles each retain the original child budget',async t=>{
 const {root,transport,diagnostics}=await setup(t,delayedFinal);
 const parallel=await Promise.allSettled([transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'UI Designer Agent'}),transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'Preview Designer Agent'})]);
 assert.equal(parallel[0].status,'fulfilled');assert.equal(parallel[1].status,'rejected');
 const first=await diagnostics();const preview=first.find(x=>x.roleLabel==='Preview Designer Agent');assert.equal(preview.outcome,'aborted');assert(preview.queueWaitMs>1500);assert(preview.executionMs<2500);assert.equal(preview.relay.providerRequests,0);assert(preview.runnerEvents.some((e:any)=>e.phase==='settled'&&e.terminationRequested));
 const serial=await independentInferencePair({chatCompletion:transport.chatCompletion,nativeInferenceConcurrency:1},()=>transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'Serial UI'}),()=>transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'Serial Preview'}));assert.equal(serial.length,2);
 const entries=await diagnostics();for(const row of entries){assert.equal(row.workspaceRemoved,true);assert.equal(row.runnerDisposed,true);for(const event of row.runnerEvents)if(event.phase==='spawned')assertGone(event.pid);}
 assert.equal((await fs.stat(path.join(root,'diagnostics'))).mode&0o777,0o700);for(const name of await fs.readdir(path.join(root,'diagnostics')))assert.equal((await fs.stat(path.join(root,'diagnostics',name))).mode&0o777,0o600);
 assert(!JSON.stringify(entries).includes('private-prompt-never-save'));assert(entries.every(x=>x.requestBytes>0&&x.taskBytes>x.requestBytes));
});
test('capacity zero-queue expiry records that no child or provider request began',async t=>{
 const {transport,diagnostics}=await setup(t,delayedFinal);
 const first=transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'First'});const blocked=transport.chatCompletion(request,{timeoutMs:80,roleLabel:'Queued only'});await assert.rejects(blocked,/timed out/);await first;
 const row=(await diagnostics()).find(x=>x.roleLabel==='Queued only');assert.equal(row.acquiredAt,null);assert.equal(row.executionMs,null);assert.equal(row.runnerCreated,false);assert.deepEqual(row.runnerEvents,[]);assert.equal(row.relay.providerRequests,0);
});
test('streaming provider metadata survives a real child timeout without prompt, stream text or credentials',async t=>{
 const upstream=http.createServer((_q,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'private-output-never-save',reasoning_content:'private-reasoning-never-save'}}]})+'\n\n');});
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(resolve=>upstream.close(()=>resolve()));});
 const script=`process.stdin.resume();fetch(process.env.LIVEUI_LLM_API_BASE+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.LIVEUI_LLM_API_KEY},body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'fixture'}],stream:true})}).then(async response=>{for await(const chunk of response.body){}}).catch(()=>{});`;
 const {transport,diagnostics}=await setup(t,script,{provider:{apiBase:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,apiKey:'provider-key-never-save'}});
 await assert.rejects(transport.chatCompletion(request,{timeoutMs:2000,roleLabel:'Streaming role'}),/timed out/);
 const row=(await diagnostics())[0];assert.equal(row.relay.providerRequests,1);assert.equal(row.relay.upstreamStatus,200);assert(row.relay.responseBytes>0);assert.equal(row.relay.contentCharacters,'private-output-never-save'.length);assert.equal(row.relay.reasoningCharacters,'private-reasoning-never-save'.length);assert.equal(row.relay.finish_reason,undefined);assert(row.runnerEvents.some((e:any)=>e.phase==='settled'));for(const event of row.runnerEvents)if(event.phase==='spawned')assertGone(event.pid);
 const text=JSON.stringify(row);for(const forbidden of ['private-prompt-never-save','private-output-never-save','private-reasoning-never-save','provider-key-never-save','http://','Bearer'])assert(!text.includes(forbidden),forbidden);
});
for(const adapter of [undefined,{chatCompletion:()=>{},nativeInferenceConcurrency:2}])test(`HTTP or multiple-capacity roles stay parallel (${Boolean(adapter)})`,async()=>{
 let first=false,second=false;let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const pair=independentInferencePair(adapter,async()=>{first=true;await gate;return 1},async()=>{second=true;await gate;return 2});assert(first&&second);release();assert.deepEqual(await pair,[1,2]);
});
test('a parent action deadline prevents starting the second lazy role',async t=>{
 let now=1000,second=false;t.mock.method(Date,'now',()=>now);
 await assert.rejects(withActionDeadline(1500,()=>independentInferencePair({chatCompletion:()=>{},nativeInferenceConcurrency:1},async()=>{now=1501;return 1},async()=>{second=true;return 2})),(e:any)=>e.code==='action_deadline_exceeded');assert.equal(second,false);
});
test('diagnostic persistence failure is bounded and reported without controlling runtime cleanup',async t=>{
 const warnings:string[]=[];t.mock.method(console,'warn',(v:any)=>warnings.push(String(v)));const start=Date.now();await persistNativeInferenceDiagnostic('/unused','fixture',{},()=>new Promise(()=>{}));assert(Date.now()-start<2000);assert(warnings.some(x=>x.includes('diagnostic_write_timeout')));
});


test('runtime disposal cancels a real child and queued role and waits for owned child exit',async t=>{
 let spawned!:(pid:number)=>void;const ready=new Promise<number>(resolve=>spawned=resolve);
 const {transport,diagnostics}=await setup(t,'process.stdin.resume();setInterval(()=>{},1000);',{},event=>{if(event.phase==='spawned')spawned(event.pid);});
 const first=transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'Active cancellation'});const firstFailure=assert.rejects(first,/transport closed/);const pid=await ready;
 const second=transport.chatCompletion(request,{timeoutMs:4000,roleLabel:'Queued cancellation'});const secondFailure=assert.rejects(second,/transport closed/);await transport.dispose();await Promise.all([firstFailure,secondFailure]);assertGone(pid);
 const rows=await diagnostics();assert.equal(rows.length,2);const active=rows.find(x=>x.roleLabel==='Active cancellation'),queued=rows.find(x=>x.roleLabel==='Queued cancellation');assert.equal(active.runnerDisposed,true);assert.equal(active.workspaceRemoved,true);assert(active.runnerEvents.some((e:any)=>e.phase==='settled'&&e.terminationRequested));assert.equal(queued.runnerCreated,false);assert.equal(queued.relay.providerRequests,0);
});
