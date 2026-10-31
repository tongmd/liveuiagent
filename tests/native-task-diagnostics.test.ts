import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeTaskDiagnostics,planAgentApp,type LlmRuntimeConfig} from '../server/liveuiagent.js';

function fixture(t:any){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-diag-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const filename=(root:string,owner:string,id:number)=>path.join(root,'task-diagnostics',createHash('sha256').update(owner).digest('hex'),`${id}.json`);
function load(root:string,owner='test',id=1){return JSON.parse(fs.readFileSync(filename(root,owner,id),'utf8'));}
const slots={appName:'Shelves',tagline:'Track your reading',accent:'#426b57',slots:[{label:'Book title',type:'string'},{label:'Reading shelf',type:'string'},{label:'Finish date',type:'date'}],actions:[{label:'Move book',description:'Move a book between shelves'},{label:'Finish book',description:'Finish a book with verdict'},{label:'Remove book',description:'Remove a book from a shelf'}],services:[],itemLabel:'Book',glyph:'📚',metric:'',metricLabel:'Books',collection:'Shelves',tileTagline:'Your reading shelves',actionVerb:'Open'};

test('actual planner transport preserves malformed model completion and selected request without new inference',async t=>{
 const root=fixture(t),diagnostic=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;let calls=0,orchestratorCalls=0;
 const raw='  { "type" : "object" }\n';
 const llm:LlmRuntimeConfig={model:'fixture',taskDiagnostics:diagnostic,chatCompletion:async(request:any)=>{
  calls++;const system=String(request.messages[0].content);
  if(system.includes('Orchestrator Agent')){orchestratorCalls++;return{choices:[{message:{content:raw}}]};}
  return{choices:[{message:{content:JSON.stringify(system.includes('Business Slot Agent')?slots:{glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'})}}]};
 }};
 await assert.rejects(()=>planAgentApp('Create a reading journal',llm),/must include agents/);diagnostic.finish('error');
 assert.equal(orchestratorCalls,1);const result=load(root);assert.equal(result.status,'error');assert.equal(result.calls.length,calls);
 const recorded=result.calls.find((x:any)=>x.stage==='Orchestrator Agent');assert.ok(recorded);assert.equal(JSON.parse(recorded.response.body).choices[0].message.content,raw);
 assert.ok(recorded.request.messages.some((x:any)=>x.content.includes('Create a reading journal')));assert.equal(recorded.model,'fixture');assert.equal(recorded.response.originalSha256,createHash('sha256').update(recorded.response.body).digest('hex'));
 assert.equal(fs.statSync(filename(root,'test',1)).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(filename(root,'test',1))).mode&0o777,0o700);
});

test('concurrent same-owner tasks and different owners cannot mix evidence; success removes only its own file',async t=>{
 const root=fixture(t);const specs=[['test',1],['test',2],['tongzhang',1]] as const;
 await Promise.all(specs.map(async([owner,id])=>{const d=createNativeTaskDiagnostics({dataDirectory:root,owner,chatId:id})!;const seq=d.begin('stage','model',{messages:[{role:'user',content:`${owner}:${id}`}]});await Promise.resolve();d.end(seq,{status:200,text:`{"value":"${owner}:${id}"}`});d.finish('error');}));
 for(const [owner,id] of specs){const data=load(root,owner,id);assert.equal(data.chatId,id);assert.equal(data.ownerHash,createHash('sha256').update(owner).digest('hex'));assert.equal(data.calls[0].request.messages[0].content,`${owner}:${id}`);}
 const done=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:3})!;done.begin('stage','model',{messages:[]});done.finish('done');assert.equal(fs.existsSync(filename(root,'test',3)),false);for(const [owner,id]of specs)assert.ok(fs.existsSync(filename(root,owner,id)));
});

test('credentials are removed before disk while ordinary message URLs remain meaningful',t=>{
 const root=fixture(t),configured='CURRENT-OPAQUE-API-CREDENTIAL',nested='nested-private-value';
 const d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1,secrets:[configured]})!;
 const plain='https://example.org/docs?q=shape';const protectedUrl='https://name:URLPASS@example.org/docs?token=QUERYSECRET&view=tree#access_token=FRAGMENTSECRET&tab=1';
 const source={apiKey:nested,echo:nested,link:plain,protectedUrl,bearer:'Bearer abc123tokensecret',basic:'Basic dXNlcjpwYXNz',jwt:'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue',github:'ghp_abcdefghijklmnop12345678',pem:'-----BEGIN PRIVATE KEY-----\nPRIVATEBODY\n-----END PRIVATE KEY-----',opaque:configured,bin:'data:image/png;base64,QUJDRA=='};
 const seq=d.begin('stage','model',{messages:[{role:'user',content:JSON.stringify(source)}],headers:{Authorization:'SHOULDNOTBERECORDED'},apiBase:'https://private.provider.example'});
 d.end(seq,{status:200,text:JSON.stringify({choices:[{message:{content:JSON.stringify(source)}}]})});d.finish('error');
 const disk=fs.readFileSync(filename(root,'test',1),'utf8');
 for(const secret of [configured,nested,'URLPASS','QUERYSECRET','FRAGMENTSECRET','abc123tokensecret','dXNlcjpwYXNz','eyJhbGci','ghp_','PRIVATEBODY','QUJDRA==','SHOULDNOTBERECORDED','private.provider.example'])assert.ok(!disk.includes(secret),secret);
 assert.ok(disk.includes(plain));assert.ok(disk.includes('view=tree'));assert.ok(disk.includes('tab=1'));assert.ok(load(root).gaps.some((x:any)=>x.reason==='binary_payload_omitted'));
});

test('whole oversized payload is omitted with explicit gap, not truncated or globally disabling future tasks',t=>{
 const root=fixture(t);const d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;
 const seq=d.begin('stage','model',{messages:[{role:'user',content:'x'.repeat(9*1024*1024)}]});d.end(seq,{status:200,text:'{"ok":true}'});d.finish('error');
 const result=load(root);assert.ok(result.gaps.some((x:any)=>x.reason==='payload_budget_exceeded'));assert.equal(result.calls[0].request.payloadOmitted,true);assert.ok(fs.statSync(filename(root,'test',1)).size<8*1024*1024);
 const d2=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:2})!;d2.begin('stage','model',{messages:[{role:'user',content:'later'}]});d2.finish('error');assert.ok(fs.existsSync(filename(root,'test',1)));assert.equal(load(root,'test',2).calls[0].request.messages[0].content,'later');
});

test('combined payload budget and unfinished calls have explicit gaps',t=>{
 const root=fixture(t),d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;
 for(let i=0;i<3;i++)d.begin('stage','model',{messages:[{role:'user',content:'x'.repeat(3*1024*1024)}]});d.finish('error');const result=load(root);
 assert.ok(result.gaps.some((x:any)=>x.reason==='file_budget_exceeded'));assert.ok(result.gaps.some((x:any)=>x.reason==='inference_not_finished_at_task_failure'));assert.ok(fs.statSync(filename(root,'test',1)).size<8*1024*1024);
});

test('storage errors preserve original transport exception; unreturned adapter bodies are explicitly unavailable',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'task-diagnostics'),'obstacle');const d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;
 const original=Object.assign(new Error('adapter refused response'),{code:'fixture_adapter_error'});const llm:LlmRuntimeConfig={model:'fixture',taskDiagnostics:d,chatCompletion:async()=>{throw original;}};
 await assert.rejects(()=>planAgentApp('A reading journal',llm),(error:any)=>error===original);assert.doesNotThrow(()=>d.finish('error'));
 fs.unlinkSync(path.join(root,'task-diagnostics'));const good=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:2})!;const seq=good.begin('stage','model',{messages:[]});good.end(seq,undefined,original);good.finish('error');assert.ok(load(root,'test',2).gaps.some((x:any)=>x.reason==='transport_failed_before_response_capture'));
});

test('unlisted owner/invalid identity cannot create diagnostics; symlink directories cannot redirect output',t=>{
 const root=fixture(t);assert.equal(createNativeTaskDiagnostics({dataDirectory:root,owner:'other',chatId:1}),undefined);assert.equal(createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:0}),undefined);
 const outside=path.join(root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(root,'task-diagnostics'));
 const d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;assert.doesNotThrow(()=>{d.begin('stage','model',{messages:[]});d.finish('error');});assert.deepEqual(fs.readdirSync(outside),[]);
});


test('duplicate sensitive JSON keys and repeated echoes never survive private disk redaction',t=>{
 const root=fixture(t),d=createNativeTaskDiagnostics({dataDirectory:root,owner:'test',chatId:1})!;const seq=d.begin('stage','model',{messages:[]});
 d.end(seq,{status:200,text:'{"password":"DUPLICATE_SECRET","password":"[redacted]","echo":"DUPLICATE_SECRET"}'});
 const second=d.begin('stage','model',{messages:[]});d.end(second,{status:200,text:String.raw`{"pass\u0077ord":"ESCAPED_SECRET","pass\u0077ord":"[redacted]","echo":"ESCAPED_SECRET"}`});d.finish('error');
 const disk=fs.readFileSync(filename(root,'test',1),'utf8');assert.ok(!disk.includes('DUPLICATE_SECRET'));assert.ok(!disk.includes('ESCAPED_SECRET'));
});
