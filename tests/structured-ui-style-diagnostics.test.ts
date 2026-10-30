import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStructuredUiStyle} from '../server/structured-ui-style.js';
import {generateStructuredUi,validateStructuredUiTree} from '../server/structured-ui.js';

const context={uiProtocol:'liveui-tree-v1',presentationContext:{styleVersion:2}};
const fontRule='fontSize: expected integer in [16,36]';
const envelope=(tree:any)=>({choices:[{message:{content:JSON.stringify({text:'Ready',data:{tree}})}}]});

for(const value of [14,48,'16px']) {
 test(`fontSize ${JSON.stringify(value)} reports the fixed integer range without modifying output`,()=>{
  const style={fontSize:value},before=structuredClone(style);
  assert.throws(()=>validateStructuredUiStyle(style,2),(error:any)=>{assert.equal(error.message,'Invalid structured UI style: '+fontRule);return true;});
  assert.deepEqual(style,before);
  const tree={type:'Stack',children:[{type:'Text',text:'private user text',style:{mobile:style}}]};
  assert.throws(()=>validateStructuredUiTree(tree,context),(error:any)=>{
   assert.equal(error.message,'Invalid structured UI: tree.children[0].style: mobile.'+fontRule);
   assert.doesNotMatch(error.message,/private user/);return true;
  });
 });
}

test('known numeric and enum fields give their original bounded contract',()=>{
 const fixtures:Array<[any,string]>=[
  [{gap:'8px'},'gap: expected integer in [0,32]'],
  [{width:159},'width: expected integer in [160,1920]'],
  [{fontWeight:450},'fontWeight: expected one of 400, 500, 600, 700'],
  [{lineHeight:1.1},'lineHeight: expected finite number in [1.3,2]'],
  [{direction:'secret value'},'direction: expected one of row, column'],
  [{fontFamily:'secret value'},'fontFamily: expected one of sans, serif, mono'],
  [{mobile:{columns:0}},'mobile.columns: expected integer in [1,4]'],
 ];
 for(const [style,message] of fixtures)assert.throws(()=>validateStructuredUiStyle(style,2),(error:any)=>{assert.equal(error.message,'Invalid structured UI style: '+message);return true;});
 for(const fontSize of [16,36])assert.deepEqual(validateStructuredUiStyle({fontSize,mobile:{fontSize}},2),{fontSize,mobile:{fontSize}});
 for(const fontSize of [15,37,16.5,NaN,Infinity,null])assert.throws(()=>validateStructuredUiStyle({fontSize},2));
});

test('nested node and mobile paths identify the actual style location',()=>{
 const tree={type:'Stack',children:[{type:'Text',text:'OK'},{type:'Grid',children:[{type:'Text',text:'private content',style:{mobile:{fontSize:48}}}]}]};
 assert.throws(()=>validateStructuredUiTree(tree,context),(error:any)=>{
  assert.equal(error.message,'Invalid structured UI: tree.children[1].children[0].style: mobile.'+fontRule);return true;
 });
});

test('one repair sees the exact path/range and corrects every nested violation in the returned tree',async()=>{
 const records=[{id:'source',value:17,text:'Original user data'}];
 const original={type:'Stack',children:[
  {type:'Text',text:'Title',style:{fontSize:48}},
  {type:'Grid',children:[{type:'Text',text:'Detail',style:{fontSize:14,mobile:{fontSize:'16px'}}}]},
  {type:'Plot',plot:{kind:'line',series:[{name:'Measured',color:'#2255cc',points:[[1,17],[2,23]]}]}},
  {type:'List',recordId:'source',children:[]},
 ]};
 const before=JSON.stringify(original);const corrected:any=structuredClone(original);
 corrected.children[0].style.fontSize=24;
 corrected.children[1].children[0].style={fontSize:18,mobile:{fontSize:16}};
 let calls=0;
 const result=await generateStructuredUi('Create a comparison workspace',{...context,records},{model:'selected-native-model',chatCompletion:async(request)=>{
  calls++;if(calls===1)return envelope(original);
  const messages=request.messages as any[];
  const repair=JSON.parse(messages.at(-1).content);
  assert.equal(repair.validationError.message,'Invalid structured UI: tree.children[0].style: '+fontRule);
  assert.match(repair.correction,/entire tree/);assert.match(repair.correction,/every children array and mobile override/);
  assert.match(repair.correction,/all fields violating the same rule/);assert.match(repair.correction,/Correct invalid presentation values/);
  assert.match(repair.correction,/user-provided numerical data, physical dimensions/);
  assert.deepEqual(JSON.parse(messages.at(-2).content).data.tree,original);
  return envelope(corrected);
 }},undefined,{validationRepairs:1,timeoutMs:1000});
 assert.equal(calls,2);assert.equal(result.timing.attempts,2);
 assert.deepEqual(result.data.tree,corrected);assert.deepEqual(result.data.tree.children![2],original.children[2]);
 assert.equal(JSON.stringify(original),before,'the host must not clamp or patch invalid style output');
});

test('a repair that leaves another font violation is rejected after exactly two calls',async()=>{
 const original={type:'Stack',children:[{type:'Text',text:'Title',style:{fontSize:48}},{type:'Text',text:'Detail',style:{mobile:{fontSize:14}}}]};
 const partial=structuredClone(original);partial.children[0].style.fontSize=24;
 let calls=0;
 await assert.rejects(generateStructuredUi('Create a view',context,{model:'fixture',chatCompletion:async()=>envelope(++calls===1?original:partial)},undefined,{validationRepairs:1}),(error:any)=>{
  assert.equal(error.message,'Invalid structured UI: tree.children[1].style: mobile.'+fontRule);
  assert.equal(error.structuredUiDiagnostic.attempts,2);
  assert.equal(error.structuredUiDiagnostic.firstValidationError.message,'Invalid structured UI: tree.children[0].style: '+fontRule);return true;
 });assert.equal(calls,2);
});

test('direct canonical style and nested tree errors never echo arbitrary unknown keys',()=>{
 const secret='arbitrary-secret\nprivate-token';
 for(const style of [{[secret]:true},{mobile:{[secret]:true}}]){
  assert.throws(()=>validateStructuredUiStyle(style,2),(error:any)=>{assert.doesNotMatch(error.message,/arbitrary-secret|private-token/);return true;});
  assert.throws(()=>validateStructuredUiTree({type:'Text',text:'private text',style},context),(error:any)=>{assert.doesNotMatch(error.message,/arbitrary-secret|private-token|private text/);return true;});
 }
});
