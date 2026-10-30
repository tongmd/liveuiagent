import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredUi,validateStructuredUiTree} from '../server/structured-ui.js';

const context={uiProtocol:'liveui-tree-v1',presentationContext:{styleVersion:2,components:['Stack','List','Text','Scene3D']}};
const scene={type:'Scene3D',scene:{objects:[{id:'private-object-name',shape:'box',position:[0,0,0],scale:[2,1,1],color:'#2255cc'}]}};
const payload=(tree:any)=>({text:'Ready',data:{tree}});
const envelope=(value:any)=>({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]});
const badScale=()=>{const value=structuredClone(scene);value.scene.objects[0].scale=[0,1,1];return value;};

test('optional repair sends original bounded output plus precise field rule to the same adapter',async()=>{
 const first=payload(badScale()),calls:any[]=[];
 const result=await generateStructuredUi('Create a room',context,{model:'selected-model',chatCompletion:async(request,options)=>{
  calls.push({request,options});return envelope(calls.length===1?first:payload(scene));
 }},undefined,{validationRepairs:1,timeoutMs:1000});
 assert.equal(calls.length,2);assert.deepEqual(result.data.tree,scene);assert.equal(result.timing.attempts,2);assert.equal(result.diagnostic.attempts,2);
 assert.match(result.diagnostic.firstValidationError!.message,/scene\.objects\[0\]\.scale/);
 assert.doesNotMatch(JSON.stringify(result.diagnostic),/private-object-name|"data"\s*:|"tree"\s*:/);
 assert.equal(calls[1].request.model,'selected-model');
 assert.deepEqual(calls[1].request.messages.slice(0,2),calls[0].request.messages);
 assert.equal(calls[1].request.messages[2].content,JSON.stringify(first));
 assert.match(calls[1].request.messages[3].content,/scene\.objects\[0\]\.scale/);
 assert.ok(calls[1].options.timeoutMs<=calls[0].options.timeoutMs);
 assert.equal(calls[1].options.roleLabel,'Structured UI Repair');
 assert.deepEqual(first,payload(badScale()),'validation must not fix model output in place');
});

test('malformed model JSON can be repaired once; the protocol envelope remains mandatory',async()=>{
 let calls=0;const result=await generateStructuredUi('Create a room',context,{model:'fixture',chatCompletion:async()=>envelope(++calls===1?'{"text":':payload(scene))},undefined,{validationRepairs:1});
 assert.equal(calls,2);assert.equal(result.diagnostic.firstValidationError?.message,'Invalid structured UI: provider output is not JSON');
 assert.deepEqual(result.data.tree,scene);
});

test('two invalid outputs fail with both the actual attempt count and first fixed-rule summary',async()=>{
 let calls=0;
 await assert.rejects(generateStructuredUi('Create a room',context,{model:'fixture',chatCompletion:async()=>{calls++;return envelope(payload(badScale()));}},undefined,{validationRepairs:1}),(error:any)=>{
  assert.equal(error.code,'invalid_structured_ui');assert.equal(error.structuredUiDiagnostic.attempts,2);
  assert.match(error.structuredUiDiagnostic.firstValidationError.message,/\.scale/);return true;
 });assert.equal(calls,2);
});

test('repair is disabled by default and invalid host budgets spend no inference',async()=>{
 let calls=0;const llm={model:'fixture',chatCompletion:async()=>{calls++;return envelope(payload(badScale()));}};
 await assert.rejects(generateStructuredUi('Create a room',context,llm),(error:any)=>error.structuredUiDiagnostic.attempts===1);
 assert.equal(calls,1);
 await assert.rejects(generateStructuredUi('Create a room',context,llm,undefined,{validationRepairs:2 as any}),/host execution budget/);
 assert.equal(calls,1);
});

test('provider failure, adapter abort and unchanged content never trigger validation repair',async()=>{
 for(const error of [Object.assign(new Error('HTTP 503'),{code:'structured_ui_provider_error'}),Object.assign(new Error('cancelled'),{name:'AbortError'})]){
  let calls=0;await assert.rejects(generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async()=>{calls++;throw error;}},undefined,{validationRepairs:1}),error);
  assert.equal(calls,1);assert.equal((error as any).structuredUiDiagnostic.attempts,1);assert.equal((error as any).structuredUiDiagnostic.firstValidationError,undefined);
 }
 let calls=0;await assert.rejects(generateStructuredUi('Change layout',{...context,tree:scene},{model:'fixture',chatCompletion:async()=>{calls++;return envelope(payload(scene));}},undefined,{validationRepairs:1}),(error:any)=>error.code==='structured_ui_unchanged'&&error.structuredUiDiagnostic.attempts===1);
 assert.equal(calls,1);
});

test('expired total budget cannot start a second call even when the first output is invalid',async t=>{
 let now=0,calls=0;t.mock.method(Date,'now',()=>now);
 await assert.rejects(generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async()=>{calls++;now=50;return envelope(payload(badScale()));}},undefined,{validationRepairs:1,timeoutMs:50}),(error:any)=>error.code==='structured_ui_timeout'&&error.structuredUiDiagnostic.attempts===1);
 assert.equal(calls,1);
});

test('repair receives only remaining time and shares the original outer timer',async t=>{
 let now=0,calls=0;const budgets:number[]=[];t.mock.method(Date,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
 const promise=generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async(_request,options)=>{
  budgets.push(options!.timeoutMs);calls++;if(calls===1){now=30;return envelope(payload(badScale()));}return new Promise(()=>{});
 }},undefined,{validationRepairs:1,timeoutMs:50});
 const rejected=assert.rejects(promise,(error:any)=>error.code==='structured_ui_timeout'&&error.structuredUiDiagnostic.attempts===2&&Boolean(error.structuredUiDiagnostic.firstValidationError));
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(budgets,[50,20]);
 t.mock.timers.tick(51);await rejected;assert.equal(calls,2);
});

test('explicit user abort prevents a repair and cancels the caller wait',async()=>{
 const controller=new AbortController();let calls=0;
 const promise=generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async()=>{calls++;return new Promise(()=>{});}},undefined,{validationRepairs:1,signal:controller.signal});
 const rejected=assert.rejects(promise,(error:any)=>error.code==='structured_ui_cancelled'&&error.structuredUiDiagnostic.attempts===1);
 controller.abort();await rejected;assert.equal(calls,1);
 let preCalls=0;await assert.rejects(generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async()=>{preCalls++;return envelope(payload(scene));}},undefined,{validationRepairs:1,signal:controller.signal}),(error:any)=>error.code==='structured_ui_cancelled');assert.equal(preCalls,0);
});

test('repair cannot bypass record preservation, renderer capabilities or input validation',async()=>{
 for(const ctx of [{...context,records:[{id:'required',text:'Keep me'}]},{...context,presentationContext:{components:['Text']}}]){
  const before=structuredClone(ctx);let calls=0;
  await assert.rejects(generateStructuredUi('Create',ctx,{model:'fixture',chatCompletion:async()=>{calls++;return envelope(payload(scene));}},undefined,{validationRepairs:1}),(error:any)=>error.code==='invalid_structured_ui'&&error.structuredUiDiagnostic.attempts===2);
  assert.equal(calls,2);assert.deepEqual(ctx,before);
 }
 let calls=0;await assert.rejects(generateStructuredUi('Create',{...context,records:[{id:'duplicate'},{id:'duplicate'}]},{model:'fixture',chatCompletion:async()=>{calls++;return envelope(payload(scene));}},undefined,{validationRepairs:1}),/unique safe/);assert.equal(calls,0);
});

test('scene errors identify object index and field without exposing IDs, labels or invalid values',()=>{
 const values:[string,any,RegExp][]=[['id','',/\.id:/],['shape','private-shape',/\.shape:/],['position',[0,21,0],/\.position:/],['scale',[0,1,1],/\.scale:/],['color','private-color',/\.color:/],['rotation',[0,361,0],/\.rotation:/]];
 for(const [field,value,pattern] of values){const tree:any=structuredClone(scene);tree.scene.objects[0][field]=value;
  assert.throws(()=>validateStructuredUiTree(tree,context),(error:any)=>{assert.equal(error.code,'invalid_structured_ui');assert.match(error.message,pattern);assert.doesNotMatch(error.message,/private-/);return true;});
 }
});


test('unknown property names never enter a thrown error or persisted diagnostic',async()=>{
 for(const tree of [{...scene,'secret-token-in-property':'hidden'}, {...scene,style:{'secret-token-in-property':'hidden'}}, {...scene,style:{'unknown\nsecret-token-in-property':'hidden'}}]){
  let calls=0;
  await assert.rejects(generateStructuredUi('Create',context,{model:'fixture',chatCompletion:async(request)=>{
   calls++;if(calls===2)assert.match(String((request.messages as any[])[2].content),/secret-token-in-property/);
   return envelope(payload(tree));
  }},undefined,{validationRepairs:1}),(error:any)=>{
   assert.equal(error.code,'invalid_structured_ui');assert.doesNotMatch(error.message,/secret-token|hidden/);
   assert.doesNotMatch(JSON.stringify(error.structuredUiDiagnostic),/secret-token|hidden/);return true;
  });assert.equal(calls,2);
 }
});
