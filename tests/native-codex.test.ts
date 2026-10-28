import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import {createCodexNativeInference} from '../server/codex-native-inference.js';
import {createNativeHarnessBindings} from '../server/native-harness.js';
import {createRuntimeSettings} from '../server/runtime-settings.js';
import {generateStructuredUi} from '../server/structured-ui.js';
import {createContextualMemory} from '../server/contextual-memory.js';
import {createPersonalization} from '../server/personalization.js';

const completion=(value:unknown)=>({model:'gpt-6-astra',choices:[{message:{role:'assistant',content:JSON.stringify(value)}}]});
async function relay(t:any, respond:(body:any,req:http.IncomingMessage,res:http.ServerResponse)=>void) {
  const calls:any[]=[];
  const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);calls.push(body);respond(body,req,res);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
  const adapter=createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:`http://127.0.0.1:${(server.address()as any).port}/v1`,LIVEUIAGENT_CODEX_TOKEN:'test-relay-secret',LIVEUIAGENT_CODEX_MODEL:'gpt-6-astra'})!;
  return {adapter,calls};
}
test('Codex configuration is host-only and does not require a DeepSeek provider key',()=>{
  assert.equal(createCodexNativeInference({}),undefined);
  assert.equal(createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://127.0.0.1:9999/v1'}),undefined);
  assert.throws(()=>createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://untrusted.example/v1',LIVEUIAGENT_CODEX_TOKEN:'private'}),/HTTPS/);
  const adapter=createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://127.0.0.1:9999/v1',LIVEUIAGENT_CODEX_TOKEN:'private'})!;
  assert.equal(adapter.view().id,'gpt-6-astra');assert.equal(adapter.view().configurable,false);
  assert.equal(adapter.config().apiKey,undefined);assert.equal(adapter.config().apiBase,undefined);
  assert.doesNotMatch(JSON.stringify(adapter.view()),/private|9999/);assert.equal(adapter.allowsUser(''),false);assert.equal(adapter.allowsUser('alice'),true);
  const restricted=createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://127.0.0.1:9999/v1',LIVEUIAGENT_CODEX_TOKEN:'private',LIVEUIAGENT_CODEX_ALLOWED_USERS:'alice, carol'})!;assert.equal(restricted.allowsUser('alice'),true);assert.equal(restricted.allowsUser('carol'),true);assert.equal(restricted.allowsUser('bob'),false);
});
test('relay uses fixed Codex model, full ordered messages, no execution tools and a bounded budget',async t=>{
  const {adapter,calls}=await relay(t,(body,req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer test-relay-secret');
    assert.equal(req.headers['x-liveui-timeout-ms'],'1234');assert.equal(body.model,'gpt-6-astra');assert.equal(body.stream,false);
    assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');res.end(JSON.stringify(completion({answer:'ok'})));
  });
  const messages=[{role:'system',content:'Return JSON'},{role:'user',content:'hello'}];
  const result:any=await adapter.chatCompletion({model:'DeepSeek-V4.1-Flash',messages,response_format:{type:'json_object'},tools:[{type:'function',function:{name:'shell'}}]}, {timeoutMs:1234});
  assert.deepEqual(calls[0].messages,messages);assert.deepEqual(calls[0].response_format,{type:'json_object'});assert.equal(result.model,'gpt-6-astra');assert.equal(calls.length,1);
});
test('relay rejects HTTP errors, malformed results and tool calls without revealing response bodies or retrying',async t=>{
  let response:any={status:503,body:'test-relay-secret private-prompt'};
  const {adapter,calls}=await relay(t,(_b,_q,res)=>{res.writeHead(response.status);res.end(typeof response.body==='string'?response.body:JSON.stringify(response.body));});
  for(const sample of [response,{status:200,body:'not-json'},{status:200,body:{choices:[{message:{content:'',tool_calls:[{}]}}]}},{status:200,body:{...completion('ok'),model:'other'}}]) {
    response=sample;await assert.rejects(adapter.chatCompletion({messages:[]},{timeoutMs:1000}),(error:any)=>error.code.startsWith('codex_')&&!/test-relay-secret|private-prompt/.test(error.message));
  }
  assert.equal(calls.length,4);
});
test('relay aborts once on deadline and refuses nonpositive budget without dispatch',async t=>{
  let dispatches=0;
  t.mock.method(globalThis,'fetch',async(_url:any,init:any)=>{dispatches++;return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));});
  const adapter=createCodexNativeInference({LIVEUIAGENT_CODEX_BASE_URL:'http://127.0.0.1:9999/v1',LIVEUIAGENT_CODEX_TOKEN:'test-secret'})!;
  await assert.rejects(adapter.chatCompletion({messages:[]},{timeoutMs:25}),(e:any)=>e.code==='codex_timeout'&&e.name!=='AbortError');
  await assert.rejects(adapter.chatCompletion({messages:[]},{timeoutMs:0}),(e:any)=>e.code==='codex_timeout');assert.equal(dispatches,1);
});
test('Codex affinity survives preference changes, owner boundaries and unavailable transport',async()=>{
  const db=new Database(':memory:');try {
    const bindings=createNativeHarnessBindings(db);bindings.save('alice','codex-app','codex');let available=true;
    const settings=createRuntimeSettings(db,{userOf:req=>String(req.header('owner')),choicesOf:()=>[{id:'native',label:'Native',available:true},{id:'dsh',label:'DSH',available:true},{id:'codex',label:'Codex',available}],modelOf:async()=>({}),appHarnessOf:(req,id)=>bindings.get(String(req.header('owner')),id)});
    const req:any={body:{},header:()=> 'alice'};
    assert.equal(settings.forRequest(req,'codex-app'),'codex');assert.equal(settings.forRequest(req),'native');assert.equal(settings.forRequest(req,'dsh_old'),'dsh');
    req.body={harness:'dsh'};assert.throws(()=>settings.forRequest(req,'codex-app'),/different harness/);
    req.body={};req.header=()=> 'bob';assert.equal(settings.forRequest(req,'codex-app'),'native');
    req.header=()=> 'alice';available=false;assert.throws(()=>settings.forRequest(req,'codex-app'),/unavailable/);
  }finally{db.close();}
});
test('rich structured UI uses the Codex adapter and preserves real record references',async t=>{
  const tree={type:'Card',children:[{type:'Text',recordId:'r1',text:'Saved title'}]};
  const {adapter,calls}=await relay(t,(_body,_req,res)=>res.end(JSON.stringify(completion({text:'Organized',data:{tree}}))));
  const result=await generateStructuredUi('Make the saved title prominent',{uiProtocol:'liveui-tree-v1',records:[{id:'r1',text:'Saved title'}]},adapter.config());
  assert.deepEqual(result.data.tree,tree);assert.equal(calls.length,1);assert.equal(calls[0].model,'gpt-6-astra');
});
test('contextual memory continues through Codex without provider credentials',async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  const {adapter,calls}=await relay(t,(_body,_req,res)=>res.end(JSON.stringify(completion({updates:[],selected_ids:[],selected_update_indexes:[],current_context:'A short answer is requested'}))));
  const memory=createContextualMemory(db);
  const result:any=await memory.process('alice',{text:'Keep replies short today',kind:'prompt'},adapter.config());
  assert.notEqual(result.status,'unavailable');assert.equal(calls.length,1);
});
test('appearance generation uses Codex while retaining validated saved settings',async t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE agent_apps(app_id TEXT,name TEXT,description TEXT,owner TEXT,updated_at TEXT); INSERT INTO agent_apps VALUES('a','Notes','Saved notes','alice','now')");
  const {adapter,calls}=await relay(t,(_body,_req,res)=>res.end(JSON.stringify(completion({title:'Notes',background:'#ffffff',surface:'#ffffff',text:'#172027',accent:'#336699',radius:8,density:'compact',font:'sans',layout:'focus'}))));
  const personal=createPersonalization(db,()=> 'alice',()=>adapter.config());
  const app=express();app.use(express.json());personal.install(app);
  const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
  const response=await fetch(`http://127.0.0.1:${(server.address()as any).port}/agent/personal/appearance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:'a',brief:'Use compact blue accents'})});
  assert.equal(response.status,200);const result:any=await response.json();
  assert.equal(result.appearance.model,'gpt-6-astra');assert.equal(result.appearance.layout,'focus');assert.equal(calls.length,1);
});

test('bounded relay failures expose only the closed safe diagnosis and keep one dispatch',async t=>{
 let code='auth_required';const {adapter,calls}=await relay(t,(_b,_q,res)=>{res.writeHead(503);res.end(JSON.stringify({error:{code,message:'private-prompt test-relay-secret'},private:'not-for-ui'}));});
 for(const [input,expected] of [['auth_required','codex_auth_required'],['auth_refresh_failed','codex_auth_refresh_failed'],['codex_http_401','codex_http_401'],['codex_http_429','codex_http_429'],['request_timeout','codex_request_timeout'],['response_failed','codex_response_failed'],['incomplete_response','codex_incomplete_response'],['codex_http_503','codex_http_503']]){code=input;await assert.rejects(adapter.chatCompletion({messages:[]},{timeoutMs:1000}),(e:any)=>e.code===expected&&e.status===502&&e.message.includes(input)&&!/private|test-relay-secret|not-for-ui/.test(e.message));}
 assert.equal(calls.length,8);
});
test('unknown, misleading and oversized relay bodies remain generic HTTP failures',async t=>{
 let body:any;const {adapter,calls}=await relay(t,(_b,_q,res)=>{res.writeHead(503);res.end(JSON.stringify(body));});
 for(const candidate of [{error:{code:'private-token',message:'auth_required'}},{error:{code:'auth_required\nsecret'}},{error:{code:'auth_required'},padding:'private'.repeat(1000)}]){body=candidate;await assert.rejects(adapter.chatCompletion({messages:[]},{timeoutMs:1000}),(e:any)=>e.code==='codex_upstream_error'&&e.message==='Codex inference failed (HTTP 503)');}
 assert.equal(calls.length,3);
});
