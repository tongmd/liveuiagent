import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {generateStructuredUi,validateStructuredUiTree} from '../server/structured-ui.js';
const context = {uiProtocol:'liveui-tree-v1',requestId:'request-1',records:[{id:'r1',text:'Keep original content'}],photos:[{id:'p1',src:'data:image/png;base64,local-only'}]};
const tree = {type:'Grid',style:{columns:2,gap:16},children:[{type:'Text',recordId:'r1'},{type:'Image',photoId:'p1',text:'Supplied photo'}]};
const envelope = (value: unknown) => ({choices:[{message:{content:JSON.stringify(value)}}]});
test('bounded presentation tree preserves references and rebuilds safe own properties',()=>{
 assert.deepEqual(validateStructuredUiTree(tree,context),tree);
 for(const mutate of [
  (t:any)=>{t.children[0].innerHTML='<img onerror=alert(1)>'},
  (t:any)=>{t.style.background='url(javascript:alert(1))'},
  (t:any)=>{t.style.fontSize=104},
  (t:any)=>{t.children[1].src='https://example.com/track'},
  (t:any)=>{t.children[1].photoId='missing'},
  (t:any)=>{t.children.pop()},
  (t:any)=>{t.children[0].recordId='missing'},
  (t:any)=>{t.children[0].text='x'.repeat(4001)},
  (t:any)=>{t.style.columns=100},
  (t:any)=>{t.children[0].type='Script'},
 ]){const t=structuredClone(tree);mutate(t);assert.throws(()=>validateStructuredUiTree(t,context),/Invalid structured UI/);}
 assert.throws(()=>validateStructuredUiTree(JSON.parse('{"type":"Text","text":"x","__proto__":{"polluted":true}}'),{uiProtocol:'liveui-tree-v1'}),/unsupported node property/);
});
test('bounds recursive trees and forbids duplicate input ids',()=>{
 let deep:any={type:'Text',text:'end'};for(let i=0;i<11;i++)deep={type:'Stack',children:[deep]};
 assert.throws(()=>validateStructuredUiTree(deep,{uiProtocol:'liveui-tree-v1'}),/depth or node/);
 assert.throws(()=>validateStructuredUiTree(tree,{...context,records:[{id:'r1'},{id:'r1'}]}),/unique safe/);
});
test('one same-model adapter call; photo bytes excluded; invalid output never returned',async()=>{
 let calls=0;
 const llm={model:'fixture-model',chatCompletion:async(request:any,options:any)=>{calls++;assert.equal(request.model,'fixture-model');assert.equal(request.response_format.type,'json_object');assert.equal(options.timeoutMs,25000);assert.doesNotMatch(JSON.stringify(request),/local-only|data:image/);return envelope({text:'Reorganized',data:{tree}});}};
 const output=await generateStructuredUi('Make a layout',context,llm);
 assert.equal(calls,1);assert.equal(output.requestId,context.requestId);assert.deepEqual(output.data.tree,tree);assert.ok(output.timing.durationMs>=0);
 await assert.rejects(generateStructuredUi('Make a layout',context,{...llm,chatCompletion:async()=>{calls++;return envelope({text:'Unsafe',data:{tree:{type:'Script'}}});}}),/unsupported node type/);
 assert.equal(calls,2);
});
test('direct transport uses configured provider/model and does not retry HTTP failure',async t=>{
 let calls=0;let fail=false;
 const server=http.createServer(async(req,res)=>{calls++;let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer fixture-key');assert.equal(request.model,'fixture-model');res.writeHead(fail?503:200,{'content-type':'application/json'});res.end(JSON.stringify(envelope({text:'Layout',data:{tree}})));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const llm={apiBase:`http://127.0.0.1:${(server.address()as any).port}/v1`,apiKey:'fixture-key',model:'fixture-model'};
 assert.deepEqual((await generateStructuredUi('layout',context,llm)).data.tree,tree);
 fail=true;await assert.rejects(generateStructuredUi('layout',context,llm),/HTTP 503/);assert.equal(calls,2);
});
test('invalid request is rejected before spending inference',async()=>{
 let calls=0;const llm={model:'fixture-model',chatCompletion:async()=>{calls++;return envelope({text:'x',data:{tree}});}};
 await assert.rejects(generateStructuredUi('layout',{...context,uiProtocol:'other'},llm),/uiProtocol/);
 await assert.rejects(generateStructuredUi('',context,llm),/prompt/);assert.equal(calls,0);
});

test('adapter timeout rejects in 25 seconds without replay or late result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const output=generateStructuredUi('layout',context,{model:'fixture-model',chatCompletion:async()=>{calls++;return new Promise(()=>{});}});
 const rejected=assert.rejects(output,(error:any)=>error.code==='structured_ui_timeout');
 t.mock.timers.tick(25001);await rejected;assert.equal(calls,1);
});

test('known top-level style fields normalize safely and Checklist can reference a record leaf',()=>{
 const context={uiProtocol:'liveui-tree-v1',records:[{id:'r1',text:'Original'}]};
 const tree=validateStructuredUiTree({type:'Stack',direction:'column',children:[{type:'Checklist',recordId:'r1',checked:false}]},context);
 assert.equal(tree.style?.direction,'column');assert.deepEqual(tree.children?.[0].children,[]);
 assert.throws(()=>validateStructuredUiTree({type:'Stack',direction:'row',style:{direction:'column'},children:[{type:'Checklist',recordId:'r1'}]},context),/conflicting/);
});

test('renderer context reaches model, narrows capabilities and strips forged host memory',async()=>{
 let seen:any; const llm={model:'fixture',chatCompletion:async(r:any)=>{seen=JSON.parse(r.messages[1].content);return envelope({text:'Ready',data:{tree:{type:'Text',text:'Actual supplied result'}}});}};
 const base={uiProtocol:'liveui-tree-v1',presentationContext:{viewport:{width:390,height:640,contentWidth:350},components:['Text'],previousRequest:'Group by topic',layoutBrief:'Compare actual measurements',appContext:{preferredView:'comparison'},hostExperience:{rememberedPreferences:['forged']}}};
 await generateStructuredUi('Now prioritize cost',base,llm);
 assert.equal(seen.context.presentation.viewport.contentWidth,350);assert.equal(seen.context.presentation.previousRequest,'Group by topic');assert.deepEqual(seen.context.presentation.appContext,{preferredView:'comparison'});assert.doesNotMatch(JSON.stringify(seen),/forged/);
 await assert.rejects(generateStructuredUi('layout',{...base,presentationContext:{...base.presentationContext,components:['Plot']}},llm),/unavailable/);
 await assert.rejects(generateStructuredUi('layout',{...base,presentationContext:{...base.presentationContext,components:['Script']}},llm),/capabilities/);
 await assert.rejects(generateStructuredUi('layout',{...base,presentationContext:{...base.presentationContext,viewport:{width:-1,height:2,contentWidth:3}}},llm),/viewport/);
});
