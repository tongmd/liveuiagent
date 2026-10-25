import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createNativeDshRelay} from '../server/dsh-native-relay.js';
async function fixture(handler:(req:http.IncomingMessage,res:http.ServerResponse)=>void){const server=http.createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return{base:`http://127.0.0.1:${(server.address() as any).port}/v1`,close:async()=>{const done=new Promise<void>(r=>server.close(()=>r()));server.closeAllConnections();await done;}};}
const inference={model:'original-selected-model',temperature:0.15,response_format:{type:'json_object'},thinking:{type:'disabled'},reasoning:{enabled:false},reasoning_effort:'none',max_tokens:1234,max_completion_tokens:1234,messages:[{role:'user',content:'original-host-messages'}]};
const dshBody={model:inference.model,messages:[{role:'system',content:'DSH system'},{role:'user',content:'full-original-handoff'}],stream:true,tools:[],temperature:1,max_tokens:32768};
test('relay preserves original role parameters on the actual wire while keeping DSH messages, model and stream',async()=>{
 let wire:any,auth:string|undefined,calls=0;
 const upstream=await fixture(async(req,res)=>{calls++;auth=req.headers.authorization;let body='';for await(const c of req)body+=c;wire=JSON.parse(body);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: [DONE]\n\n');});
 const relay=await createNativeDshRelay({provider:{apiBase:upstream.base,apiKey:'actual-provider-secret'},request:inference,signal:new AbortController().signal});
 try{assert.notEqual(relay.provider.apiKey,'actual-provider-secret');assert.equal(relay.provider.apiBase.includes('127.0.0.1'),true);
 const response=await fetch(relay.provider.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+relay.provider.apiKey,'content-type':'application/json'},body:JSON.stringify(dshBody)});assert.equal(response.status,200);await response.text();
 for(const k of ['temperature','response_format','thinking','reasoning','reasoning_effort','max_tokens','max_completion_tokens'])assert.deepEqual(wire[k],(inference as any)[k]);
 assert.deepEqual(wire.messages,dshBody.messages);assert.equal(wire.model,inference.model);assert.equal(wire.stream,true);assert.equal(wire.tools,undefined);assert.equal(auth,'Bearer actual-provider-secret');assert.equal(calls,1);
 }finally{await relay.close();await upstream.close();}
});
test('relay rejects unauthorized requests, other routes, model drift, exposed tools and oversized bodies before provider invocation',async()=>{
 let calls=0;const upstream=await fixture((_req,res)=>{calls++;res.end('{}');});const relay=await createNativeDshRelay({provider:{apiBase:upstream.base,apiKey:'secret'},request:{model:'same',messages:[]},signal:new AbortController().signal,maxRequestBytes:1024});
 const send=(body:any,token=relay.provider.apiKey,route='/chat/completions')=>fetch(relay.provider.apiBase+route,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});
 try{assert.equal((await send({model:'same',messages:[]},'wrong')).status,401);assert.equal((await send({model:'same',messages:[]},relay.provider.apiKey,'/models')).status,404);assert.equal((await send({model:'other',messages:[]})).status,409);assert.equal((await send({model:'same',messages:[],tools:[{type:'function',function:{name:'bash'}}]})).status,400);assert.equal((await send({model:'same',messages:[{role:'user',content:'x'.repeat(2000)}]})).status,413);assert.equal(calls,0);
 }finally{await relay.close();await upstream.close();}
});
test('one shared deadline aborts upstream, closes the relay listener and never retries a request',async()=>{
 let calls=0,received!:()=>void;const gotRequest=new Promise<void>(r=>received=r);const upstream=await fixture(()=>{calls++;received();});const controller=new AbortController();const relay=await createNativeDshRelay({provider:{apiBase:upstream.base,apiKey:'secret'},request:{model:'same',messages:[]},signal:controller.signal});
 const client=fetch(relay.provider.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+relay.provider.apiKey},body:JSON.stringify({model:'same',messages:[],stream:true})});const failed=assert.rejects(client);await gotRequest;controller.abort(new Error('deadline'));await relay.close();await failed;await assert.rejects(fetch(relay.provider.apiBase+'/chat/completions'));assert.equal(calls,1);await upstream.close();
});

test('token length termination is rejected even when emitted text happens to be valid JSON',async()=>{
 const upstream=await fixture((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'{"ok":true}'},finish_reason:null}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n'),10);});
 const relay=await createNativeDshRelay({provider:{apiBase:upstream.base,apiKey:'secret'},request:{model:'same',messages:[],max_tokens:1024},signal:new AbortController().signal});
 try{await assert.rejects(async()=>{const result=await fetch(relay.provider.apiBase+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+relay.provider.apiKey},body:JSON.stringify({model:'same',messages:[],stream:true})});await result.text();});}finally{await relay.close();await upstream.close();}
});
