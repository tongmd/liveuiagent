import test from 'node:test';import assert from 'node:assert/strict';
import {currentNativeActionRequest,NATIVE_CURRENT_ACTION_SCOPE_POLICY} from '../server/liveuiagent.js';
test('host action context preserves exact current view identity and original event without inferring an old operation',()=>{
 const event={entityId:'3086',entityName:'实际研究卡',sourceComponentId:'d_view742',value:false,number:0};
 const original=JSON.stringify(event);const request=currentNativeActionRequest('agent_turn_3.run',{label:'查看完整内容',description:'仅按note ID读取正文'},event);
 assert.deepEqual(request,{currentAction:{id:'agent_turn_3.run',label:'查看完整内容',description:'仅按note ID读取正文'},uiEvent:event});assert.equal(JSON.stringify(event),original);assert.match(NATIVE_CURRENT_ACTION_SCOPE_POLICY,/not authorization/);assert.match(NATIVE_CURRENT_ACTION_SCOPE_POLICY,/must only retrieve and display/);
});
test('different save, infer and delete buttons retain distinct host identities over the same row',()=>{
 const event={entityId:'3086'};const identities=['保存研究卡','推演验证方案','删除研究卡'].map((label,i)=>currentNativeActionRequest(`agent_turn_${i+1}.run`,{label},event));assert.deepEqual(identities.map(x=>x.currentAction.label),['保存研究卡','推演验证方案','删除研究卡']);assert.ok(identities.every(x=>x.uiEvent===event));
});
