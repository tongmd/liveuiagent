import test from 'node:test';
import assert from 'node:assert/strict';
import {domainFieldUnion,persistedDomainPolicy} from '../server/native-domain-fields.js';
import {makeBusinessFields,refineBusinessFieldsWithSchemas} from '../server/liveuiagent.js';
const reply=(value:unknown)=>({choices:[{message:{content:JSON.stringify(value)}}]});
const need='Keep named entries and their quantities; mark an entry checked and remember that annotation when reopened.';
const raw=()=>({appName:'Entry tracker',tagline:'Keep entry annotations',accent:'#426b57',slots:[{label:'Entry title',type:'string',required:false},{label:'Quantity',type:'number',required:false}],persistedDomainFields:[],actions:[{label:'Add',description:'Add an entry'},{label:'Check',description:'Mark one entry checked',perItem:true,consumedSlotIndices:[]}],services:['catalog'],primaryMembership:'app_local',itemLabel:'Entry',glyph:'📚',tileTagline:'Entry tracker',metricLabel:'Entries',collection:'Entries',actionVerb:'Open'});
const capability:any={id:'catalog.list',permission:'catalog.list',source:'appworld',appName:'catalog',apiName:'list',method:'GET',purpose:'Read current entries',inputSchema:{type:'object'}};
async function initial(){return makeBusinessFields(need,'Entries',[],{focus:'Entries',resultFocus:'Entries'},{model:'fixture',chatCompletion:async()=>reply(raw())},[{name:'catalog',description:'Public entry directory'}]);}
const invalid=()=>{const d=raw();return{slots:d.slots,actions:d.actions,persistedDomainFields:[...d.slots.map(({label,type})=>({label,type})),{label:'Checked',type:'boolean'}]};};
test('strict union reports exact conflicting field and both namespaces without mutating or dropping a declaration',()=>{
 const inputs:any=[{name:'entry_title',label:'Entry title',type:'string'}],state:any=[{name:'entry_title',label:'Entry title',type:'string'}];const before=structuredClone({inputs,state});
 assert.throws(()=>domainFieldUnion(inputs,state),(error:any)=>{assert.match(error.message,/persistedDomainFields\[0\] name "entry_title"/);assert.match(error.message,/slots\[0\] name "entry_title"/);assert.match(error.message,/only additional state/);return true;});assert.deepEqual({inputs,state},before);
 assert.throws(()=>domainFieldUnion(inputs,[{...state[0],name:'other',label:'  Ｅｎｔｒｙ   Ｔｉｔｌｅ  '}]),/normalized label "entry title" conflicts with slots\[0\]/);
 assert.throws(()=>domainFieldUnion([],state.concat(state)),/persistedDomainFields\[1\].*persistedDomainFields\[0\]/);
});
test('actual normalization rejects duplicate labels even when non-ASCII labels receive different host names',async()=>{
 const d=raw();d.slots=[{label:'条目名称',type:'string',required:false}];const value={...d,persistedDomainFields:[{label:'条目名称',type:'string'}]};let calls=0;
 await assert.rejects(makeBusinessFields('保存条目名称','Entries',[],{focus:'Entries',resultFocus:'Entries'},{model:'fixture',chatCompletion:async()=>{calls++;return reply(value);}},[{name:'catalog',description:'Public directory'}]),/persistedDomainFields\[0\] normalized label.*slots\[0\]/);assert.equal(calls,1);
});
test('one existing strict repair receives a precise collision and can return additional state only, with unchanged original inputs',async()=>{
 const design=await initial();const original=structuredClone(design);const bad=invalid();const packets:any[]=[];const roles:string[]=[];
 const result=await refineBusinessFieldsWithSchemas({prompt:need,subject:'Entries',design,capabilities:[capability],llm:{model:'fixture',chatCompletion:async(request,options)=>{
  roles.push(options!.roleLabel!);const packet=JSON.parse(request.messages[1].content);packets.push(packet);
  assert.match(request.messages[0].content,/Input slots already belong to the persistent schema/);assert.match(request.messages[0].content,/ONLY additional state absent from slots/);
  if(packets.length===1){assert.deepEqual(packet.hostOfferedAppState.declaredFields.map((f:any)=>f.name),['entry_title','quantity']);return reply(bad);}
  assert.deepEqual(packet.contractRepair.invalidOutput,bad);assert.match(packet.contractRepair.validationMessage,/persistedDomainFields\[0\] name "entry_title".*slots\[0\] name "entry_title"/);assert(!packet.contractRepair.validationMessage.includes('checked'),'host error identifies collision without suggesting desired business fields');
  return reply({...bad,persistedDomainFields:[{label:'Checked',type:'boolean'}]});
 }}});
 assert.deepEqual(roles,['Schema-aware Business Slot Agent','Schema-aware Business Slot Contract Repair']);const{contractRepair,...unchanged}=packets[1];assert.deepEqual(unchanged,packets[0]);assert.equal(result.slots.length,2);assert.deepEqual(result.persistedDomainFields,[{name:'checked',label:'Checked',type:'boolean'}]);assert.deepEqual(design,original);
});
test('repeated colliding outputs fail after the existing repair, never deduplicate locally or request a third call',async()=>{
 const design=await initial();let calls=0;await assert.rejects(refineBusinessFieldsWithSchemas({prompt:need,subject:'Entries',design,capabilities:[capability],llm:{model:'fixture',chatCompletion:async()=>{calls++;return reply(invalid());}}}),/Domain field collision/);assert.equal(calls,2);
 assert.match(persistedDomainPolicy,/already belong to the declared persistent record schema/);assert.match(persistedDomainPolicy,/Do not repeat any normalized field name or label/);
});
