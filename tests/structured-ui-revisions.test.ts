import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredUi} from '../server/structured-ui.js';

const original={type:'Scene3D',scene:{title:'Room',background:'#f4f5f6',grid:true,objects:[
 {id:'desk',shape:'box',position:[0,0,0],scale:[1.4,.7,.7],color:'#885533',label:'Desk'},
 {id:'shelf',shape:'box',position:[-1,0,0],scale:[.8,1.8,.3],color:'#447788',label:'Shelf'}
]}};
const context={uiProtocol:'liveui-tree-v1',records:[],photos:[],tree:original};
function llm(tree:any,inspect?:(request:any)=>void){return {model:'test-model',chatCompletion:async(request:any)=>{inspect?.(request);return {choices:[{message:{content:JSON.stringify({text:'Updated',data:{tree}})}}]};}};}
test('scene edits receive geometry and move only the requested object',async()=>{
 const before=structuredClone(original);
 const result=await generateStructuredUi('Move the desk to the right; keep all dimensions',context,llm({type:'Scene3D',editVisual:'v0',sceneEdits:{objects:[{id:'desk',position:[1.2,0,0]}]}},request=>{
  const payload=JSON.parse(request.messages[1].content);assert.deepEqual(payload.context.existingVisuals[0].scene,original.scene);
  assert.match(request.messages[0].content,/CONTENT EDIT/);
 }));
 const scene=(result.data.tree as any).scene;assert.deepEqual(scene.objects[0].position,[1.2,0,0]);assert.deepEqual(scene.objects[0].scale,original.scene.objects[0].scale);assert.deepEqual(scene.objects[1],original.scene.objects[1]);assert.deepEqual(original,before);
});
test('scene edits add/remove objects but still validate renderer bounds',async()=>{
 const edit={type:'Scene3D',editVisual:'v0',sceneEdits:{removeObjectIds:['shelf'],addObjects:[{id:'chair',shape:'box',position:[0,0,1],scale:[.5,.5,.5],color:'#667788'}]}};
 const result=await generateStructuredUi('Replace the shelf with a chair',context,llm(edit));assert.deepEqual((result.data.tree as any).scene.objects.map((o:any)=>o.id),['desk','chair']);
 for(const patch of [{objects:[{id:'missing',position:[0,0,0]}]},{objects:[{id:'desk',position:[1000,0,0]}]},{removeObjectIds:['missing']},{objects:[{id:'desk',script:'alert(1)'}]},{addObjects:[original.scene.objects[0]]}]){
  await assert.rejects(generateStructuredUi('change',context,llm({type:'Scene3D',editVisual:'v0',sceneEdits:patch})));
 }
});
test('returning the original scene is not acknowledged as a successful edit',async()=>{
 for(const tree of [original,{type:'Scene3D',reuseVisual:'v0'},{type:'Scene3D',editVisual:'v0',sceneEdits:{objects:[{id:'desk',position:[0,0,0]}]}}]){
  let calls=0;await assert.rejects(generateStructuredUi('Make a new subject',context,llm(tree,()=>{calls++;})),(e:any)=>e.code==='structured_ui_unchanged');assert.equal(calls,1);
 }
});
test('restyling can reuse exact geometry while changing the presentation',async()=>{
 const result=await generateStructuredUi('Make the scene taller',{...context,presentationContext:{styleVersion:2}},llm({type:'Scene3D',reuseVisual:'v0',style:{height:500}}));assert.deepEqual((result.data.tree as any).scene,original.scene);assert.equal(result.data.tree.style?.height,500);
});
test('editing cannot mix payload overrides, unknown references or cross-type references',async()=>{
 for(const tree of [{type:'Scene3D',editVisual:'v0',reuseVisual:'v0',sceneEdits:{}},{type:'Scene3D',editVisual:'v9',sceneEdits:{}},{type:'Plot',editVisual:'v0',sceneEdits:{}},{type:'Scene3D',editVisual:'v0',scene:original.scene,sceneEdits:{}}])await assert.rejects(generateStructuredUi('change',context,llm(tree)));
});
