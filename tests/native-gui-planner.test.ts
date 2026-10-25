import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {createGuiInteractionPlanner,validateInteractionInput,validateInteractionStep} from '../server/gui-interaction-planner.js';
import {planNativeGuiInteractionStep} from '../server/liveuiagent.js';
import {withActionDeadline,remainingActionMs} from '../server/action-deadline.js';
const view={visibleText:'Books',fields:[{target:'e1',label:'Book title',type:'text',value:'',required:true},{target:'e2',label:'Shelf',type:'select-one',value:'todo',options:[{label:'To read',value:'todo'},{label:'Finished',value:'done'}]},{target:'e3',label:'Finished',type:'checkbox',value:'on',checked:false}],buttons:[{target:'e4',label:'Add book',actionId:'record.add',contextText:'Piranesi — To read'}]};
const input=()=>({appId:'owned',harness:'dsh',model:'fixture-selected',userMessage:'Add Piranesi to my to-read shelf',snapshot:structuredClone(view),observations:[]});
async function setup(t:any,overrides:any={}){
 let plans=0,dispatches=0;const modelInputs:any[]=[];
 const llm={model:'fixture-selected',apiKey:'private-provider-key',apiBase:'https://provider.invalid',personalContext:'private personal context',chatCompletion:async(request:any)=>{dispatches++;modelInputs.push(request);return{choices:[{message:{content:JSON.stringify({kind:'fill',target:'e1',value:'Piranesi'})}}]};}};
 const handler=createGuiInteractionPlanner({owner:()=> 'alice',authorize:(id,owner)=>{if(id!=='owned'||owner!=='alice')throw Object.assign(Error('not found'),{status:404});},resolve:()=>({harness:'dsh',llm}),plan:async(...args:any[])=>{plans++;return planNativeGuiInteractionStep(args[0],args[1],args[2]);},...overrides});
 const app=express();app.use(express.json());app.post('/evaluator/interaction-step',handler);app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message,code:e.code,plannerModelCalls:e.plannerModelCalls}));
 const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const post=async(body:any,headers={})=>{const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/evaluator/interaction-step`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json() as any};};
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
 const budgets:number[]=[];const llm={model:'fixture-selected',chatCompletion:async()=>{budgets.push(remainingActionMs());return{choices:[{message:{content:JSON.stringify({kind:'done',reason:'Observed UI already matches current request'})}}]};}};
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
