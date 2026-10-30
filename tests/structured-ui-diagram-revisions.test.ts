import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredUi} from '../server/structured-ui.js';

const diagram={title:'Research route',nodes:[
 {id:'question',label:'Define the research question',x:0.1,y:0.5,color:'#2255cc'},
 {id:'experiment',label:'Run the controlled experiment',x:0.5,y:0.5,color:'#2255cc'},
 {id:'analysis',label:'Analyze the measured results',x:0.9,y:0.5,color:'#2255cc'},
],edges:[{from:'question',to:'experiment',label:'Test the hypothesis'},{from:'experiment',to:'analysis',label:'Compare the outcomes'}]};
const plot={kind:'line',title:'Measurements',series:[{name:'Observed',color:'#2255cc',points:[[1,0.0245],[2,0.0317]]}]};
const scene={objects:[{id:'desk',shape:'box',position:[0,0,0],scale:[1.4,0.7,0.7],color:'#2255cc'}]};
const previous={type:'Stack',children:[{type:'Diagram',diagram},{type:'Plot',plot},{type:'Scene3D',scene}]};
const context={uiProtocol:'liveui-tree-v1',tree:previous,presentationContext:{styleVersion:2}};
const response=(tree:any)=>({choices:[{message:{content:JSON.stringify({text:'Updated',data:{tree}})}}]});

test('explicit vertical Diagram revision receives the exact graph and can replace internal coordinates and labels',async()=>{
 const original=structuredClone(previous),revised=structuredClone(diagram);
 revised.nodes=revised.nodes.map((node,index)=>({...node,x:0.5,y:0.1+index*0.4,label:['Question','Experiment','Analysis'][index]}));
 let calls=0;
 const result=await generateStructuredUi('Make the route vertical and shorten the node labels; keep the same relationships and all measurements',context,{model:'selected-harness-model',chatCompletion:async(request)=>{
  calls++;const messages=request.messages as any[],system=messages[0].content,input=JSON.parse(messages[1].content);
  assert.match(system,/changes limited to the outer layout or styling/);
  assert.match(system,/explicitly requests a different internal Diagram layout/);
  assert.match(system,/return a complete diagram payload instead of reuseVisual/);
  assert.match(system,/Preserve node IDs, edge endpoints and direction/);
  assert.match(system,/factual meaning/);
  assert.match(system,/Diagram edits do not authorize changing Plot measurements or Scene3D geometry/);
  assert.deepEqual(input.context.existingVisuals[0].diagram,diagram);
  assert.deepEqual(input.context.existingVisuals[0].diagram.edges,diagram.edges);
  assert.equal(input.context.previousTree.children[0].reuseVisual,'v0');
  assert.equal(input.context.existingVisuals[1].plot,undefined,'Plot arrays still use exact server-side reuse');
  assert.deepEqual(input.context.existingVisuals[2].scene,scene,'Scene edit context is unchanged');
  return response({type:'Stack',children:[{type:'Diagram',diagram:revised},{type:'Plot',reuseVisual:'v1'},{type:'Scene3D',reuseVisual:'v2'}]});
 }});
 assert.equal(calls,1);
 assert.deepEqual((result.data.tree.children![0] as any).diagram,revised);
 assert.deepEqual((result.data.tree.children![0] as any).diagram.nodes.map((node:any)=>node.id),diagram.nodes.map(node=>node.id));
 assert.deepEqual((result.data.tree.children![0] as any).diagram.edges,diagram.edges);
 assert.deepEqual((result.data.tree.children![1] as any).plot,plot);
 assert.deepEqual((result.data.tree.children![2] as any).scene,scene);
 assert.deepEqual(previous,original,'the host does not hand-edit the model tree or original graph');
});

test('outer Diagram styling still reuses every original coordinate, label and edge exactly',async()=>{
 const result=await generateStructuredUi('Make the diagram viewport taller without changing the graph',{uiProtocol:'liveui-tree-v1',tree:{type:'Diagram',diagram},presentationContext:{styleVersion:2}},{model:'fixture',chatCompletion:async()=>response({type:'Diagram',reuseVisual:'v0',style:{height:500}})});
 assert.deepEqual((result.data.tree as any).diagram,diagram);assert.equal(result.data.tree.style?.height,500);
});
