import test from 'node:test';import assert from 'node:assert/strict';
import {makeBusinessFields,refineBusinessFieldsWithSchemas,planAgentApp} from '../server/liveuiagent.js';
const reply=(x:any)=>({choices:[{message:{content:JSON.stringify(x)}}]});
const values=['R&B / Soul','MiXeD_Case','非ASCII 值','Same','same'];
const need='Keep entries using exactly these user-defined modes: '+JSON.stringify(values)+'. Save one selected mode.';
const raw=()=>({appName:'Mode entries',tagline:'Save a chosen mode',accent:'#426b57',persistedDomainFields:[],slots:[{label:'Mode',type:'select',required:false,options:values.map(value=>({label:value,value}))}],actions:[{label:'Save entry',description:'Save the selected mode'}],primaryMembership:'app_local',services:[],itemLabel:'Entry',glyph:'📝',tileTagline:'Mode entries',metricLabel:'Entries',collection:'Entries',actionVerb:'Save'});
const initial=(design=raw(),prompt=need,inspect?:(system:string)=>void)=>makeBusinessFields(prompt,'Entries',[],{focus:'Entries',resultFocus:'Saved'},{model:'fixture',chatCompletion:async request=>{inspect?.(request.messages[0].content);return reply(design);}});
test('initial select preserves exact user-defined values, including case, punctuation, underscores and non-ASCII',async()=>{
 const result=await initial(undefined,undefined,system=>{assert.match(system,/no selected public API schemas/);assert.match(system,/closed set.*explicitly supplied/);assert.match(system,/string\/text search/);assert(!system.includes('lowercase ascii slug'));});assert.deepEqual(result.slots[0].options?.map(o=>o.value),values);
});
test('value validation rejects exact duplicates, non-string, blank and overlong values without truncation or silent deduplication',async()=>{
 for(const bad of [values[0],'x'.repeat(41),42,'   ']){const d=raw();(d.slots[0].options[1]as any).value=bad;await assert.rejects(initial(d),/duplicate exact|non-empty string.*40/);}
 const d=raw();d.slots[0].options[0].value=' '.repeat(2)+'Case_Value'+' ';assert.equal((await initial(d)).slots[0].options?.[0].value,'  Case_Value ');
});
test('schema refinement retains real API enum values and exposes open-catalog control instruction in its existing single call',async()=>{
 const design=await initial();let calls=0;const cap:any={source:'appworld',appName:'directory',apiName:'choose',method:'GET',purpose:'Choose an actual mode',inputSchema:{type:'object',properties:{mode:{type:'string',enum:values},query:{type:'string'}}}};
 const result=await refineBusinessFieldsWithSchemas({prompt:need,subject:'Entries',design:{...design,services:['directory']},capabilities:[cap],llm:{model:'fixture',chatCompletion:async request=>{calls++;assert.match(request.messages[0].content,/actual enum in the supplied selected public API schemas/);assert.match(request.messages[0].content,/Open service catalogs.*string\/text/);const p=JSON.parse(request.messages[1].content);assert.deepEqual(p.selectedPublicCapabilities[0].requestSchema.properties.mode.enum,values);return reply({persistedDomainFields:[],slots:raw().slots,actions:raw().actions});}}});assert.equal(calls,1);assert.deepEqual(result.slots[0].options?.map(o=>o.value),values);
});
test('open catalog and unconstrained subjective preference remain explicit free text, never host-coerced select',async()=>{
 const d=raw();(d.slots as any)=[{label:'Search catalog',type:'string',required:false},{label:'Preference',type:'text',required:false}];const result=await initial(d,'Search the available service catalog and describe my preference freely.');assert.deepEqual(result.slots.map(s=>s.type),['string','text']);assert(result.slots.every(s=>s.options===undefined));
 const missing=raw();delete(missing.slots[0]as any).options;await assert.rejects(initial(missing),/options array/);
});
test('actual Orchestrator normalization preserves all exact option values from generated business controls',async()=>{
 let initialCalls=0,orchestratorCalls=0;const plan=await planAgentApp(need,{model:'fixture',chatCompletion:async request=>{const system=request.messages[0].content;if(system.includes('Orchestrator Agent')){orchestratorCalls++;const p=JSON.parse(request.messages[1].content);return reply({workflowId:'fixture',agents:p.minimumValidAgents,routes:p.minimumValidRoutes,sharedState:p.minimumValidSharedState,dataModels:p.minimumValidDataModels,uiPlan:p.minimumValidUiPlan});}if(system.includes('Business Slot Agent')){initialCalls++;return reply(raw());}return reply({glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'});}});
 assert.equal(initialCalls,1);assert.equal(orchestratorCalls,1);assert.deepEqual(plan.interaction.businessFields[0].options?.map(o=>o.value),values);const modelField=plan.orchestration.dataModels.flatMap(m=>m.fields).find(f=>f.name===plan.interaction.businessFields[0].name);assert.deepEqual(modelField?.options?.map(o=>o.value),values);
});
