import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {currentHostCommandRoute,GUI_INTERACTION_SYSTEM,resolveControlPreparation,validateInteractionInput} from '../server/gui-interaction-planner.js';
import {hostCommandDescriptor} from '../server/native-host-command.js';
import {planNativeGuiInteractionStep} from '../server/liveuiagent.js';
const saved=JSON.parse(fs.readFileSync(new URL('./fixtures/gui-command-route-saved-inputs.json',import.meta.url),'utf8'));
const descriptor=hostCommandDescriptor();
// New protocol observation fixture. It does not claim the old snapshots contained these IDs.
function observed(p:any){const i=structuredClone(p);const f=i.snapshot.fields.at(-1);assert.equal(f.label,'Ask this app');f.componentId=descriptor.inputId;for(const b of i.snapshot.buttons){if(b.actionId===descriptor.actionId)b.componentId=descriptor.buttonId;if(b.actionId===descriptor.prepareActionId)b.componentId=descriptor.prepareButtonId;}return i;}
const command=(i:any)=>({operation:{},fields:[],action:{kind:'command',target:currentHostCommandRoute(i)!.executeTarget,value:i.userMessage,quote:i.userMessage}});
for(const savedInput of saved.probes)test(`${savedInput.caseId}: actual planner receives typed current route; host compiles command fill then fresh-snapshot click`,async()=>{
 assert.equal(currentHostCommandRoute(savedInput),undefined,'old input is not guessed from its label');
 const i=observed(savedInput),before=structuredClone(i.snapshot.fields);let calls=0;const requests:any[]=[];
 const llm:any={model:'fixture',chatCompletion:async(req:any)=>{calls++;requests.push(req);return{choices:[{message:{content:JSON.stringify(command(i))}}]};}};
 validateInteractionInput({appId:'fixture',harness:'native',model:'fixture',userMessage:i.userMessage,snapshot:i.snapshot,observations:i.observations});
 const fill=await planNativeGuiInteractionStep(GUI_INTERACTION_SYSTEM,i,llm);
 const model=JSON.parse(requests[0].messages.find((m:any)=>m.role==='user').content);
 assert.deepEqual(model.hostCommandRoute,currentHostCommandRoute(i));assert.equal(model.hostCommandRoute.prepare.enabled,false);assert.equal(model.hostCommandRoute.preparationRequired,false);
 assert.deepEqual(fill,{kind:'fill',target:before.at(-1)!.target,value:i.userMessage});
 assert.deepEqual(i.snapshot.fields,before,'planning never mutates even a draft');i.snapshot.fields.at(-1).value=i.userMessage;
 assert.deepEqual(await planNativeGuiInteractionStep(GUI_INTERACTION_SYSTEM,i,llm),{kind:'click',target:model.hostCommandRoute.executeTarget});assert.equal(calls,2);
 assert.deepEqual(i.snapshot.fields.slice(0,-1),before.slice(0,-1),'required or optional domain composers are untouched');
});
test('route is strict observation, never label authorization or unsupported-to-click conversion',()=>{
 const i=observed(saved.probes[0]),p=command(i);
 for(const mutate of [(x:any)=>delete x.snapshot.fields.at(-1).componentId,(x:any)=>x.snapshot.fields.at(-1).readOnly=true,(x:any)=>x.snapshot.fields.at(-1).disabled=true,(x:any)=>x.snapshot.buttons.find((b:any)=>b.actionId===descriptor.actionId).disabled=true,(x:any)=>x.snapshot.fields.push({...x.snapshot.fields.at(-1),target:'e99'}),(x:any)=>x.snapshot.buttons.find((b:any)=>b.actionId===descriptor.actionId).componentId='model_button']){const bad=structuredClone(i);mutate(bad);assert.equal(currentHostCommandRoute(bad),undefined);assert.throws(()=>resolveControlPreparation(p,bad),/host-bound/);}
 assert.deepEqual(resolveControlPreparation({operation:{},fields:[],action:{kind:'unsupported',reason:'The necessary identity is not known for this current target.'}},i),{kind:'unsupported',reason:'The necessary identity is not known for this current target.'});
 assert.throws(()=>resolveControlPreparation({...p,fields:[{target:i.snapshot.fields[0].target,decision:'set',value:'invented'}]},i),/unrelated/);
 assert.throws(()=>resolveControlPreparation({...p,operation:{rowContextQuote:'other row'}},i),/row/);
 assert.throws(()=>resolveControlPreparation({...p,action:{...p.action,value:'Invented command',quote:'Invented command'}},i),/literal/);
 assert.throws(()=>resolveControlPreparation({...p,action:{...p.action,value:i.userMessage,quote:'Set'}},i),/literal/);
});
test('after completion only literal unfinished command is compiled; nonce and receipt stay outside planning',()=>{
 const i=observed(saved.probes[0]);i.userMessage='Create Alpha, then archive Beta.';i.observations=[{step:{kind:'click',target:'e1'},ok:true}];
 const p=command(i);p.action.value=p.action.quote='archive Beta.';
 assert.deepEqual(resolveControlPreparation(p,i),{kind:'fill',target:i.snapshot.fields.at(-1).target,value:'archive Beta.'});
 assert.throws(()=>validateInteractionInput({appId:'fixture',harness:'native',model:'fixture',userMessage:i.userMessage,snapshot:i.snapshot,observations:[],hostCommandRoute:currentHostCommandRoute(i)}),/unsupported fields: hostCommandRoute/);
 assert.equal('requestId' in currentHostCommandRoute(i)!,false);assert.match(GUI_INTERACTION_SYSTEM,/entire current userMessage is a legitimate command/);assert.match(GUI_INTERACTION_SYSTEM,/never repeat completed siblings/);
});
