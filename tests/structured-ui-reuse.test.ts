import test from 'node:test';
import assert from 'node:assert/strict';
import {generateStructuredUi} from '../server/structured-ui.js';
const plot={type:'Plot',recordId:'r',plot:{title:'实际读数',kind:'line',xLabel:'时刻',series:[{name:'测量',color:'#008866',points:[[0,.012345],[1,9.87654321]]}]}};
const diagram={type:'Diagram',diagram:{title:'原关系',nodes:[{id:'a',label:'问题',x:.2,y:.3,color:'#112233'},{id:'b',label:'检验',x:.8,y:.7,color:'#668899'}],edges:[{from:'a',to:'b',label:'验证'}]}};
const scene={type:'Scene3D',scene:{objects:[{id:'a',shape:'sphere',position:[0,1,2],scale:[1,1,1],color:'#336699'}]}};
const previous:any={type:'Stack',children:[plot,diagram,scene]};
const context:any={uiProtocol:'liveui-tree-v1',records:[{id:'r',text:'保留原始值'}],photos:[],tree:previous,presentationContext:{styleVersion:2}};
const reply=(tree:any)=>({choices:[{message:{content:JSON.stringify({text:'完成',data:{tree}})}}]});
test('style-only adapter request uses compact per-request refs; final tree restores exact payloads without renderer changes',async()=>{
 const before=JSON.stringify(previous);let calls=0;
 const expected:any={type:'Grid',style:{columnWeights:[2,1],maxWidth:1100},children:[{type:'Plot',reuseVisual:'v0',recordId:'r',style:{height:350}},{type:'Diagram',reuseVisual:'v1'},{type:'Scene3D',reuseVisual:'v2'}]};
 const result=await generateStructuredUi('放宽画布并改成深蓝色比较布局，数据保持',context,{model:'fixture',chatCompletion:async(req:any)=>{calls++;const c=JSON.parse(req.messages[1].content).context;assert.equal(c.existingVisuals.length,3);assert.deepEqual(c.existingVisuals.map((v:any)=>v.id),['v0','v1','v2']);assert.equal(c.existingVisuals[0].series[0].pointCount,2);assert.equal(c.previousTree.children[0].reuseVisual,'v0');assert.equal(c.previousTree.children[0].plot,undefined);assert.equal(JSON.stringify(c).includes('9.87654321'),false);assert.match(req.messages[0].content,/presentation-only changes MUST reuse/);return reply(expected);}} as any);
 assert.equal(calls,1);assert.deepEqual(result.data.tree.children?.map((n:any)=>n.plot||n.diagram||n.scene),[plot.plot,diagram.diagram,scene.scene]);assert.equal(JSON.stringify(result.data.tree).includes('reuseVisual'),false);assert.equal(JSON.stringify(previous),before);assert.equal(result.data.tree.children?.[0].recordId,'r');
});
test('reuse cannot select missing/foreign refs, change type/payload, skip source records or import a client registry',async()=>{
 const invoke=(tree:any,c:any=context)=>generateStructuredUi('改布局',c,{model:'fixture',chatCompletion:async()=>reply(tree)} as any);
 for(const tree of [{type:'Plot',reuseVisual:'v99',recordId:'r'},{type:'Diagram',reuseVisual:'v0',recordId:'r'},{type:'Plot',reuseVisual:'v0',recordId:'r',plot:plot.plot},{type:'Plot',reuseVisual:'v0',recordId:'r',url:'https://evil.invalid'},{type:'Plot',reuseVisual:'v0'}])await assert.rejects(invoke(tree));
 await assert.rejects(invoke({type:'Plot',reuseVisual:'v0',recordId:'r'},{...context,tree:undefined,existingVisuals:[{id:'v0',type:'Plot',plot:plot.plot}]}),/unknown visual reference/);
 await assert.rejects(invoke({type:'Plot',reuseVisual:'v0',recordId:'r'},{...context,tree:undefined,presentationContext:{styleVersion:2,existingVisuals:[plot]}}),/unknown visual reference/);
});
test('invalid previous visual is rejected before model; final expansion still enforces tree limits and capabilities',async()=>{
 let calls=0;await assert.rejects(generateStructuredUi('布局',{...context,tree:{...plot,plot:{...plot.plot,url:'https://evil.invalid'}}},{model:'fixture',chatCompletion:async()=>{calls++;return reply({type:'Plot',reuseVisual:'v0',recordId:'r'});}} as any),/invalid previous visual/);assert.equal(calls,0);
 await assert.rejects(generateStructuredUi('布局',{...context,presentationContext:{styleVersion:2,components:['Stack','Text']}},{model:'fixture',chatCompletion:async()=>reply({type:'Plot',reuseVisual:'v0',recordId:'r'})} as any),/unavailable/);
 await assert.rejects(generateStructuredUi('布局',context,{model:'fixture',chatCompletion:async()=>reply({type:'Stack',children:[{type:'Plot',reuseVisual:'v0',recordId:'r'},...Array.from({length:5},()=>({type:'Scene3D',reuseVisual:'v2'}))]})} as any),/at most 4/);
});
