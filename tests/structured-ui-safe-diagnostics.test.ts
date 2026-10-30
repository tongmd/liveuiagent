import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateStructuredUi} from '../server/structured-ui.js';
const context={uiProtocol:'liveui-tree-v1',presentationContext:{styleVersion:2}};
const payload=(tree:any)=>JSON.stringify({text:'private-result',data:{tree}});
const secret='private-user-token-and-text';
const tree=(fontSize:any)=>({type:'Stack',children:[{type:'Text',text:secret,style:{mobile:{fontSize}}}]});
const llm=(contents:string[])=>{let i=0;return {model:'fixture',chatCompletion:async()=>({choices:[{message:{content:contents[i++]}}]})};};
test('each failed attempt records exact fixed location/value plus SHA and byte count without model text',async()=>{
 const contents=[payload(tree(48)),payload(tree(secret))];
 await assert.rejects(generateStructuredUi('fixture',context,llm(contents),undefined,{validationRepairs:1}), (error:any)=>{
  const d=error.structuredUiDiagnostic;assert.equal(d.attempts,2);assert.equal(d.responses.length,2);
  for(let i=0;i<2;i++){
   assert.equal(d.responses[i].attempt,i+1);
   assert.equal(d.responses[i].contentSha256,createHash('sha256').update(contents[i]).digest('hex'));
   assert.equal(d.responses[i].contentBytes,Buffer.byteLength(contents[i]));
   assert.equal(d.responses[i].validation.nodePath,'tree.children[0]');
   assert.equal(d.responses[i].validation.field,'style.mobile.fontSize');
   assert.match(d.responses[i].validation.rule,/expected integer in \[16,36\]/);
  }
  assert.deepEqual(d.responses[0].validation.received,{type:'number',value:48});
  assert.deepEqual(d.responses[1].validation.received,{type:'string'});
  assert.doesNotMatch(JSON.stringify(d),/private-user|private-result/);return true;
 });
});
test('numeric/boolean/type descriptors never copy arbitrary strings, arrays, object keys, or labels',async()=>{
 for(const value of [secret,{[secret]:secret},[secret],false,null]){
  await assert.rejects(generateStructuredUi('fixture',context,llm([payload(tree(value))])),(e:any)=>{
   assert.doesNotMatch(JSON.stringify(e.structuredUiDiagnostic),/private-user|private-result/);
   if(value===false)assert.deepEqual(e.structuredUiDiagnostic.responses[0].validation.received,{type:'boolean',value:false});
   return true;
  });
 }
});
test('parse failures retain only hash/bytes and static response rule; repaired success retains both attempts',async()=>{
 const content='{'+secret,valid=payload(tree(20));
 const result=await generateStructuredUi('fixture',context,llm([content,valid]),undefined,{validationRepairs:1});
 assert.equal(result.diagnostic.responses.length,2);
 assert.deepEqual(result.diagnostic.responses[0].validation,{nodePath:'response',rule:'Invalid structured UI: provider output is not JSON'});
 assert.equal(result.diagnostic.responses[1].validation,undefined);
 assert.doesNotMatch(JSON.stringify(result.diagnostic),/private-user|private-result/);
});
