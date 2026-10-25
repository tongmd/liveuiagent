import {groundingViewContext} from '../server/grounding-view.js';
import {hostCommandComponents} from '../server/native-host-command.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {nativeViewBudget} from '../server/native-view-budget.js';
import {viewFixture} from './fixtures/native-view-surface.js';
test('complete25 and31 rows fit actual three-action graph including installed host controls, without slicing',()=>{
 for(const rows of [0,25,31]){const f=viewFixture(rows);const before=structuredClone(f.surface);const result=nativeViewBudget(f.surface,f.descriptor);const hostButtons=hostCommandComponents().filter(n=>n.component==='Button').length;assert.equal(result.rows,rows);assert.equal(result.fields,4);assert.equal(result.rowButtons,3);assert.equal(result.buttons,rows*3+1+hostButtons);assert.equal(result.globalButtons,1+hostButtons);assert.deepEqual(result.reservedHostCommand,{fields:0,buttons:0});assert.deepEqual(f.surface,before);}
});
test('actual control boundary and absent-host conservative reservation reject overfull views rather than return prefixes',()=>{
 const good=viewFixture(32);assert(nativeViewBudget(good.surface,good.descriptor).buttons<=100);const bad=viewFixture(33);assert.throws(()=>nativeViewBudget(bad.surface,bad.descriptor),/controls/);assert.equal(bad.surface.initialData.entities.length,33);
 const absent=viewFixture(32,{host:false});const budget=nativeViewBudget(absent.surface);assert.deepEqual(budget.reservedHostCommand,{fields:1,buttons:hostCommandComponents().filter(n=>n.component==='Button').length});assert.equal(budget.buttons,97);
});
test('zero row actions do not imply unlimited support; actual text and encoding remain bounded',()=>{
 const f=viewFixture(25,{rowActions:0});assert.equal(nativeViewBudget(f.surface,f.descriptor).rows,25);
 const long=viewFixture(25,{rowActions:0,metadata:'x'.repeat(3000)});assert.throws(()=>nativeViewBudget(long.surface,long.descriptor),/text/);
 const many=viewFixture(10000,{rowActions:0});assert.throws(()=>nativeViewBudget(many.surface,many.descriptor),/text|work/);assert.equal(many.surface.initialData.entities.length,10000);
});
test('unknown graph, dangling or cyclic bindings, malformed host descriptor fail closed',()=>{
 for(const mutate of [(s:any)=>s.messages[0].updateComponents.components.push({id:'root',component:'Text',text:'bad'}),(s:any)=>s.messages[0].updateComponents.components[0].child='missing',(s:any)=>s.messages[0].updateComponents.components.find((n:any)=>n.id==='d_overview').children.push('root'),(s:any)=>s.initialData.draft.statValue=null]){const f=viewFixture(25);mutate(f.surface);assert.throws(()=>nativeViewBudget(f.surface,f.descriptor));}
 const f=viewFixture(25);assert.throws(()=>nativeViewBudget(f.surface,{...f.descriptor,buttonId:'forged'}),/host_command_contract/);const empty=viewFixture(0);empty.surface.messages[0].updateComponents.components.find((n:any)=>n.id==='d_item_title').component='Unknown';assert.throws(()=>nativeViewBudget(empty.surface,empty.descriptor),/unknown/);
});
test('UTF8 encoded view has its own bound even when controls and visible label text fit',()=>{
 const f=viewFixture(1);const nodes=f.surface.messages[0].updateComponents.components;for(const node of nodes)if(node.component==='TextField'&&!String(node.id).startsWith('host_')){node.variant='choice';node.options=Array.from({length:300},()=>({label:'Choice',value:'界'.repeat(1000)}));}
 assert.throws(()=>nativeViewBudget(f.surface,f.descriptor),/encoding/);assert.equal(f.surface.initialData.entities.length,1);
});

test('budget metadata requires explicit compiled Native host opt-in; unknown legacy graphs are not silently validated',()=>{
 const f=viewFixture(25);const pkg:any={manifest:{intent:{itemLabel:'Entry'}},actions:{actions:{}},ui:{meta:{a2ui:f.surface,hostCommand:f.descriptor}}};
 assert.equal(groundingViewContext(pkg)?.viewResourceBudget,undefined);
 assert.equal(groundingViewContext(pkg,{compiledNativeBudget:true})?.viewResourceBudget?.rows,25);
 pkg.ui.meta.a2ui.messages[0].updateComponents.components.find((n:any)=>n.id==='d_item_title').component='Tabs';
 assert.equal(groundingViewContext(pkg)?.viewResourceBudget,undefined);
 assert.throws(()=>groundingViewContext(pkg,{compiledNativeBudget:true}),/unknown/);
 // Actual authoritative publication still invokes the same strict graph checker.
 assert.throws(()=>nativeViewBudget(pkg.ui.meta.a2ui,f.descriptor),/unknown/);
});
