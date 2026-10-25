import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {createGuiInteractionPlanner,validateInteractionInput,validateInteractionStep,resolveControlPreparation,GUI_INTERACTION_SYSTEM} from '../server/gui-interaction-planner.js';
import {planNativeGuiInteractionStep} from '../server/liveuiagent.js';
import {withActionDeadline,remainingActionMs} from '../server/action-deadline.js';
const view={visibleText:'Books',fields:[{target:'e1',label:'Book title',type:'text',value:'',required:true},{target:'e2',label:'Shelf',type:'select-one',value:'todo',options:[{label:'To read',value:'todo'},{label:'Finished',value:'done'}]},{target:'e3',label:'Finished',type:'checkbox',value:'on',checked:false}],buttons:[{target:'e4',label:'Add book',actionId:'record.add',contextText:'Piranesi — To read'}]};
const input=()=>({appId:'owned',harness:'dsh',model:'fixture-selected',userMessage:'Add Piranesi to my to-read shelf',snapshot:structuredClone(view),observations:[]});
// Existing fixture intents explicitly upgraded to the single current protocol.
// Production has no legacy-contract fallback; raw missing-binding rejection is
// independently covered in gui-operation-binding.test.ts.
function bindFixture(proposal:any,context:any){
 if(!Array.isArray(proposal?.fields)||!proposal.action)return proposal;
 const selected=context.snapshot.buttons.find((b:any)=>b.target===proposal.action.target);
 return {...proposal,operation:{quote:context.userMessage,...(proposal.action.kind==='click'?{...(selected?.contextText?{rowContextQuote:selected.contextText}:{})}:{})},fields:proposal.fields.map((d:any)=>({...d,binding:d.decision==='set'?'current':'unspecified'}))};
}
function resolveFixturePreparation(proposal:any,context:any){return resolveControlPreparation(bindFixture(proposal,context),context);}
async function setup(t:any,overrides:any={}){
 let currentInput:any;let plans=0,dispatches=0;const modelInputs:any[]=[];
 const llm={model:'fixture-selected',apiKey:'private-provider-key',apiBase:'https://provider.invalid',personalContext:'private personal context',chatCompletion:async(request:any)=>{dispatches++;modelInputs.push(request);return{choices:[{message:{content:JSON.stringify({fields:[{target:'e1',decision:'set',value:'Piranesi',source:'user',quote:'Piranesi'},{target:'e2',decision:'keep'},{target:'e3',decision:'keep'}],action:{kind:'click',target:'e4'}})}}]};}};
 const fixtureResolve=()=>{const resolved=overrides.resolve?overrides.resolve():{harness:'dsh',llm};if(!resolved.llm?.chatCompletion)return resolved;const original=resolved.llm.chatCompletion;return {...resolved,llm:{...resolved.llm,chatCompletion:async(...args:any[])=>{const reply=await original(...args);const content=reply?.choices?.[0]?.message?.content;if(typeof content!=='string')return reply;const parsed=JSON.parse(content);reply.choices[0].message.content=JSON.stringify(bindFixture(parsed,currentInput));return reply;}}};};
 const handler=createGuiInteractionPlanner({owner:()=> 'alice',authorize:(id,owner)=>{if(id!=='owned'||owner!=='alice')throw Object.assign(Error('not found'),{status:404});},resolve:()=>({harness:'dsh',llm}),plan:async(...args:any[])=>{plans++;return planNativeGuiInteractionStep(args[0],args[1],args[2]);},...overrides,resolve:fixtureResolve});
 const app=express();app.use(express.json());app.post('/evaluator/interaction-step',handler);app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message,code:e.code,planningContractInvalid:e.planningContractInvalid,plannerModelCalls:e.plannerModelCalls}));
 const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const post=async(body:any,headers={})=>{currentInput=body;const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/evaluator/interaction-step`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json() as any};};
 return{post,modelInputs,counts:()=>({plans,dispatches})};
}
test('real HTTP pure step endpoint uses actual selected DSH adapter and keeps provider/personal data off the planner input and response',async t=>{
 const {post,modelInputs,counts}=await setup(t);const {status,body}=await post(input());assert.equal(status,200);assert.deepEqual(body.step,{kind:'fill',target:'e1',value:'Piranesi'});assert.deepEqual(body.execution,{harness:'dsh',model:'fixture-selected'});assert.equal(body.plannerModelCalls,1);assert.equal(body.providerRequests,null);assert.deepEqual(counts(),{plans:1,dispatches:1});
 assert.equal(modelInputs[0].max_tokens,8192,'the bounded completion allowance must include reasoning before the step JSON');assert.equal(modelInputs[0].max_completion_tokens,undefined);assert.equal(modelInputs[0].tools,undefined);const request=JSON.stringify(modelInputs);assert.ok(!request.includes('private-provider-key'));assert.ok(!request.includes('private personal context'));assert.ok(!JSON.stringify(body).includes('private-'));assert.equal(JSON.parse(modelInputs[0].messages[1].content).userMessage,input().userMessage);
 const system=modelInputs[0].messages[0].content;assert.match(system,/bound action button immediately executes that business action/);assert.match(system,/never assume it opens an editor/);assert.match(system,/first fill the currently visible fields relevant to that action/);assert.match(system,/explicit values supplied in the current userMessage/);assert.match(system,/Editing a draft field is not itself a business mutation/);assert.match(system,/onchange business actions are blocked by the host gate/);assert.match(system,/return unsupported/);
});
test('endpoint rejects gold/future/provider fields and unauthorized app before any inference',async t=>{
 const {post,counts}=await setup(t);
 for(const extra of [{expectedBehavior:'gold'},{assertions:[]},{futureEpisodes:[]},{llm:{apiKey:'secret'}},{deadlineMs:999999},{snapshot:{...view,hiddenInputs:[]}}])assert.equal((await post({...input(),...extra})).status,400);
 assert.equal((await post({...input(),appId:'foreign'})).status,404);assert.equal((await post(input(),{'x-liveuiagent-llm-key':'secret'})).status,400);assert.deepEqual(counts(),{plans:0,dispatches:0});
});
test('DSH planner cannot quietly use direct provider or another model',async t=>{
 for(const resolved of [{harness:'dsh',llm:{model:'fixture-selected',apiKey:'x',apiBase:'http://invalid'}},{harness:'native',llm:{model:'fixture-selected'}},{harness:'dsh',llm:{model:'other',chatCompletion:async()=>{throw Error('not called');}}}]){
  const {post,counts}=await setup(t,{resolve:()=>resolved});const result=await post(input());assert.ok([409,503].includes(result.status));assert.equal(counts().plans,0);
 }
});
test('strict steps operate only current editable fields and real bound actions/options',()=>{
 const parsed=validateInteractionInput(input());assert.deepEqual(validateInteractionStep({kind:'select',target:'e2',value:'done'},parsed.snapshot),{kind:'select',target:'e2',value:'done'});
 for(const step of [{kind:'click',target:'e1'},{kind:'fill',target:'e2',value:'all request text'},{kind:'select',target:'e2',value:'unknown'},{kind:'check',target:'e1',checked:true},{kind:'click',target:'invented'},{kind:'execute',code:'fetch()'},{kind:'done',passed:true},{kind:'unsupported'}])assert.throws(()=>validateInteractionStep(step,parsed.snapshot));
 const nativeWidgets={...view,fields:[{target:'e5',label:'Shelf',type:'choice',value:'To read',options:[{value:'To read',label:'To read'},{value:'Finished',label:'Finished'}]},{target:'e6',label:'Notify me',type:'switch',value:'false',checked:false}]};
 assert.equal(validateInteractionStep({kind:'select',target:'e5',value:'Finished'},nativeWidgets).kind,'select');assert.equal(validateInteractionStep({kind:'check',target:'e6',checked:true},nativeWidgets).kind,'check');
 assert.equal(validateInteractionStep({kind:'unsupported',reason:'UI has no bulk import control'},view).kind,'unsupported');
 assert.throws(()=>validateInteractionInput({...input(),observations:[{step:{kind:'click',target:'e4'},ok:true,expectedBehavior:'future'}]}));
});
test('planner parent deadline only shortens inference budget and late decisions are never returned',async t=>{
 let calls=0;const llm={model:'fixture-selected',chatCompletion:async()=>{calls++;await new Promise(r=>setTimeout(r,1700));return{choices:[{message:{content:JSON.stringify({kind:'done',reason:'No action'})}}]};}};
 const {post}=await setup(t,{timeoutMs:1000,resolve:()=>({harness:'dsh',llm})});const result=await post(input());assert.equal(result.status,504);assert.equal(result.body.code,'action_deadline_exceeded');assert.equal(calls,1);
 let budget=0;await assert.rejects(withActionDeadline(Date.now()+500,()=>planNativeGuiInteractionStep('One step',{}, {model:'fixture',chatCompletion:async(_r,o)=>{budget=o!.timeoutMs!;await new Promise(r=>setTimeout(r,900));return{};}})),(e:any)=>e.code==='action_deadline_exceeded');assert.ok(budget>0&&budget<=500);await new Promise(r=>setTimeout(r,1800));
});

 test('remaining episode budget can shorten but never enlarge host planner deadline',async t=>{
 const budgets:number[]=[];const llm={model:'fixture-selected',chatCompletion:async()=>{budgets.push(remainingActionMs());return{choices:[{message:{content:JSON.stringify({fields:view.fields.map(f=>({target:f.target,decision:'keep'})),action:{kind:'done',reason:'Observed UI already matches current request'}})}}]};}};
 const {post}=await setup(t,{timeoutMs:1000,resolve:()=>({harness:'dsh',llm})});
 assert.equal((await post({...input(),remainingBudgetMs:20000,stepsRemaining:20,clicksRemaining:8})).status,200);assert.ok(budgets[0]>0&&budgets[0]<=1000);
 assert.equal((await post({...input(),remainingBudgetMs:500,stepsRemaining:1,clicksRemaining:0})).status,200);assert.ok(budgets[1]>0&&budgets[1]<=500);
 assert.equal((await post({...input(),remainingBudgetMs:0})).status,400);assert.equal((await post({...input(),clicksRemaining:41})).status,400);
});


test('bounded GUI planner still rejects truncated DSH completion once without retry or any action',async t=>{
 let adapterCalls=0;
 const {post,counts}=await setup(t,{resolve:()=>({harness:'dsh',llm:{model:'fixture-selected',chatCompletion:async(request:any)=>{adapterCalls++;assert.equal(request.max_tokens,8192);throw Object.assign(Error('Native model output reached its token limit'),{code:'dsh_native_output_truncated'});}}})});
 const result=await post(input());assert.equal(result.status,500);assert.equal(result.body.code,'dsh_native_output_truncated');assert.equal(result.body.plannerModelCalls,1);assert.equal(adapterCalls,1);assert.equal(counts().plans,1);assert.equal(result.body.step,undefined);
});

test('host preparation always returns actual field changes before an immediate business click',()=>{
 const context={userMessage:'Set new time to 05:45, shelf Finished and check Finished',snapshot:structuredClone(view)};
 const proposal={fields:[{target:'e3',decision:'set',checked:true,source:'user',quote:'check Finished'},{target:'e2',decision:'set',value:'done',source:'visible',quote:'Finished'},{target:'e1',decision:'set',value:'05:45',source:'user',quote:'05:45'}],action:{kind:'click',target:'e4'}};
 assert.deepEqual(resolveFixturePreparation(proposal,context),{kind:'fill',target:'e1',value:'05:45'});
 context.snapshot.fields[0].value='05:45';assert.deepEqual(resolveFixturePreparation(proposal,context),{kind:'select',target:'e2',value:'done'});
 context.snapshot.fields[1].value='done';assert.deepEqual(resolveFixturePreparation(proposal,context),{kind:'check',target:'e3',checked:true});
 context.snapshot.fields[2].checked=true;assert.deepEqual(resolveFixturePreparation(proposal,context),{kind:'click',target:'e4'});
});
test('preparation rejects incomplete ambiguous invented and non-visible decisions without returning any operation',()=>{
 const context={userMessage:'Add Piranesi',snapshot:view};
 const valid:any={fields:[{target:'e1',decision:'set',value:'Piranesi',source:'user',quote:'Piranesi'},{target:'e2',decision:'keep'},{target:'e3',decision:'keep'}],action:{kind:'click',target:'e4'}};
 for(const mutate of [(p:any)=>p.fields.pop(),(p:any)=>p.fields[1].target='e1',(p:any)=>p.fields[0].quote='future hidden answer',(p:any)=>p.fields[0].source='observation',(p:any)=>p.fields[1]={target:'e2',decision:'set',value:'invented',source:'visible',quote:'Finished'},(p:any)=>p.fields[2].value='invented',(p:any)=>p.action={kind:'fill',target:'e1',value:'Piranesi'},(p:any)=>p.fields[0].api='hidden']){const p=structuredClone(valid);mutate(p);assert.throws(()=>resolveFixturePreparation(p,context));}
 assert.throws(()=>resolveFixturePreparation({kind:'click',target:'e4'},context),'legacy direct-click model output cannot bypass preparation');
 const unsupported={...valid,action:{kind:'unsupported',reason:'No visible label editor exists'}};assert.equal(resolveFixturePreparation(unsupported,context).kind,'unsupported');
});

test('preparation preserves optional keep and handles explicit clear, false, zero and equivalent numbers',()=>{
 const context={userMessage:'Clear note and turn alerts off; set count to 0',snapshot:{visibleText:'Current count 0',fields:[{target:'e1',label:'Note',type:'text',value:'old'},{target:'e2',label:'Alerts',type:'switch',value:'true',checked:true},{target:'e3',label:'Count',type:'number',value:'0.0'},{target:'e4',label:'Optional',type:'text',value:'retain'}],buttons:[{target:'e5',label:'Save',actionId:'save'}]}};
 const p={fields:[{target:'e1',decision:'set',value:'',source:'user',quote:'Clear note'},{target:'e2',decision:'set',checked:false,source:'user',quote:'alerts off'},{target:'e3',decision:'set',value:'0',source:'user',quote:'0'},{target:'e4',decision:'keep'}],action:{kind:'click',target:'e5'}};
 assert.deepEqual(resolveFixturePreparation(p,context),{kind:'fill',target:'e1',value:''});context.snapshot.fields[0].value='';assert.deepEqual(resolveFixturePreparation(p,context),{kind:'check',target:'e2',checked:false});context.snapshot.fields[1].checked=false;assert.deepEqual(resolveFixturePreparation(p,context),{kind:'click',target:'e5'});assert.equal(context.snapshot.fields[3].value,'retain');
});

test('sequential ordinary form policy preserves precise unsupported and no invented optional data boundaries',()=>{
 assert.match(GUI_INTERACTION_SYSTEM,/multiple items does not by itself require a bulk or atomic action/);
 assert.match(GUI_INTERACTION_SYSTEM,/observing each confirmed result/);
 assert.match(GUI_INTERACTION_SYSTEM,/never repeat an already confirmed mutation/);
 assert.match(GUI_INTERACTION_SYSTEM,/empty list lacks collection capability/);
 assert.match(GUI_INTERACTION_SYSTEM,/explicitly required bulk or atomic operation cannot be replaced/);
 assert.match(GUI_INTERACTION_SYSTEM,/Optional unspecified amount.date fields must remain unchanged/);
 assert.match(GUI_INTERACTION_SYSTEM,/Never automatically resend a mutation whose outcome is unknown/);
 const context={userMessage:'Create Alpha and Beta',snapshot:{visibleText:'Items empty',fields:[{target:'e1',label:'Name',type:'text',value:''},{target:'e2',label:'Optional amount',type:'number',value:'0'}],buttons:[{target:'e3',label:'Create',actionId:'create'}]}};
 const p={fields:[{target:'e1',decision:'set',value:'Alpha',source:'user',quote:'Alpha'},{target:'e2',decision:'keep'}],action:{kind:'click',target:'e3'}};
 assert.deepEqual(resolveFixturePreparation(p,context),{kind:'fill',target:'e1',value:'Alpha'});
 context.snapshot.fields[0].value='Alpha';assert.deepEqual(resolveFixturePreparation(p,context),{kind:'click',target:'e3'});
 assert.equal(context.snapshot.fields[1].value,'0');
 assert.equal(resolveFixturePreparation({...p,action:{kind:'unsupported',reason:'An atomic transaction is explicitly required but no atomic control exists'}},context).kind,'unsupported');
});

test('real HTTP marks only model preparation contract errors and accepts separate bounded feedback',async t=>{
 let modelCalls=0;const captured:any[]=[];
 const llm={model:'fixture-selected',chatCompletion:async(body:any)=>{modelCalls++;captured.push(JSON.parse(body.messages[1].content));return{choices:[{message:{content:JSON.stringify(modelCalls===1?{fields:[],action:{kind:'done',reason:'Done'},unexpected:'private-value-must-not-echo'}:{fields:view.fields.map(f=>({target:f.target,decision:'keep'})),action:{kind:'done',reason:'No further UI operation'}})}}]};}};
 const {post}=await setup(t,{resolve:()=>({harness:'dsh',llm})});const first=await post(input());assert.equal(first.status,400);assert.equal(first.body.code,'invalid_gui_interaction');assert.equal(first.body.planningContractInvalid,true);assert.equal(first.body.plannerModelCalls,1);assert.match(first.body.error,/unexpected/);assert.ok(!first.body.error.includes('private-value'));
 const next=await post({...input(),planningFeedback:{kind:'invalid_planning_contract',message:first.body.error}});assert.equal(next.status,200);assert.equal(next.body.plannerModelCalls,1);assert.equal(modelCalls,2);assert.deepEqual(captured[1].observations,[]);assert.equal(captured[1].planningFeedback.kind,'invalid_planning_contract');
 const invalid=await post({...input(),planningFeedback:{kind:'performed_click',message:'wrong'}});assert.equal(invalid.status,400);assert.equal(invalid.body.planningContractInvalid,undefined);assert.equal(invalid.body.plannerModelCalls,0);
});

test('completed-item policy preserves actual episode evidence and prepares next requested item without optional metadata or hidden intent',async t=>{
 const snapshot={visibleText:'Created Alpha. Saved items: Alpha',fields:[{target:'e1',label:'Item identifier',type:'text',value:'Alpha'},{target:'e2',label:'Optional display name',type:'text',value:''}],buttons:[{target:'e3',label:'Create',actionId:'create'}]};const observation={step:{kind:'click',target:'e3'},ok:true,snapshot};let request:any;let calls=0;
 const llm={model:'fixture-selected',chatCompletion:async(body:any)=>{calls++;request=body;return{choices:[{message:{content:JSON.stringify({fields:[{target:'e1',decision:'set',value:'Beta',source:'user',quote:'Beta'},{target:'e2',decision:'keep'}],action:{kind:'click',target:'e3'}})}}]};}};
 const {post}=await setup(t,{resolve:()=>({harness:'dsh',llm})});const result=await post({...input(),userMessage:'Create Alpha and Beta',snapshot,observations:[observation]});assert.equal(result.status,200);assert.equal(calls,1);assert.deepEqual(result.body.step,{kind:'fill',target:'e1',value:'Beta'});const supplied=JSON.parse(request.messages[1].content);assert.deepEqual(supplied.observations,[observation]);assert.equal(supplied.userMessage,'Create Alpha and Beta');assert.equal(supplied.originalAppIntent,undefined);assert.equal(snapshot.fields[1].value,'');
 const system=request.messages[0].content;assert.match(system,/optional metadata absence does not undo the confirmed operation/);assert.match(system,/Composer values left over from a completed operation are not a pending item/);assert.match(system,/next distinct unfinished target explicitly requested in the current userMessage/);assert.match(system,/not proof by itself that the business goal succeeded/);assert.match(system,/actual update affordance rather than repeating/);assert.match(system,/Never automatically resend a mutation whose outcome is unknown/);
});

test('completed row metadata stays visible without contaminating the next target preparation',async t=>{
 const userMessage='Send reminders for invoice 81 to billing@cedar.example, invoice 92 to accounts@harbor.example, and invoice 103 to invoices@meadow.example.';
 const completedView={visibleText:'Cedar Works · invoice 81 · billing@cedar.example · Reminder sent. Pending invoice 92: accounts@harbor.example. Pending invoice 103: invoices@meadow.example.',fields:[{target:'e1',label:'Client name',type:'text',value:'',required:false},{target:'e2',label:'Recipient',type:'email',value:'billing@cedar.example',required:true},{target:'e3',label:'Invoice number',type:'text',value:'81',required:true}],buttons:[{target:'e4',label:'Send reminder',actionId:'send'},{target:'e5',label:'View',actionId:'view',contextText:'Cedar Works · invoice 81 · Reminder sent'}]};
 const observation={step:{kind:'click',target:'e4'},ok:true,snapshot:structuredClone(completedView)};
 const original=structuredClone(completedView);const requests:any[]=[];
 const llm={model:'fixture-selected',chatCompletion:async(body:any)=>{requests.push(body);const system=body.messages[0].content;assert.match(system,/ONE ACTION, ONE CURRENT TARGET/);assert.match(system,/completed or unrelated row does not support/);assert.match(system,/Keep an empty optional target-specific field empty/);assert.match(system,/Never combine one item’s identity/);
 return{choices:[{message:{content:JSON.stringify({fields:[{target:'e1',decision:'keep'},{target:'e2',decision:'set',value:'accounts@harbor.example',source:'user',quote:'accounts@harbor.example'},{target:'e3',decision:'set',value:'92',source:'user',quote:'92'}],action:{kind:'click',target:'e4'}})}}]};}};
 const {post}=await setup(t,{resolve:()=>({harness:'dsh',llm})});
 const supplied=()=>({...input(),userMessage,snapshot:completedView,observations:[observation]});
 const first=await post(supplied());assert.equal(first.status,200);assert.deepEqual(first.body.step,{kind:'fill',target:'e2',value:'accounts@harbor.example'});assert.equal(first.body.plannerModelCalls,1);
 completedView.fields[1].value='accounts@harbor.example';const second=await post(supplied());assert.deepEqual(second.body.step,{kind:'fill',target:'e3',value:'92'});
 completedView.fields[2].value='92';const ready=await post(supplied());assert.deepEqual(ready.body.step,{kind:'click',target:'e4'});assert.equal(completedView.fields[0].value,'','no client name was inferred from the completed row');
 assert.equal(requests.length,3);for(const request of requests){const packet=JSON.parse(request.messages[1].content);assert.equal(packet.userMessage,userMessage);assert.deepEqual(packet.observations,[observation]);assert.equal(packet.originalAppIntent,undefined);assert.equal(packet.snapshot.visibleText,original.visibleText,'completed row remains available as actual observation, not removed to influence the planner');}
 assert.deepEqual(observation.snapshot,original,'no rewriting of completed evidence');
});
