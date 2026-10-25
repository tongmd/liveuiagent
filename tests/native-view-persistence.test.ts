import test from 'node:test';import assert from 'node:assert/strict';
import {viewRuntimeFixture} from './fixtures/native-view-runtime.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
for(const count of [25,31])test(`actual authoritative ${count} rows survive SQLite persistence and fresh connection reopen without truncation`,async t=>{
  const rows:any[]=Array.from({length:count},(_,i)=>({id:String(i),name:'Parcel '+i,detail:'In current collection'}));if(count===25){rows[0]={name:'Shared parcel',group:'First group',detail:'One actual primary unit'};rows[1]={name:'Shared parcel',group:'Other group',detail:'Another actual primary unit'};}const f=await viewRuntimeFixture(t,rows);let decisions=0;
  const chatCompletion=async(request:any)=>{const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split("\n")[0]);
   if(sys.includes('You analyze a GUI'))return reply({objective:'Read actual current parcels',deliverables:['Current complete parcel list']});
   if(sys.includes('You are an INDEPENDENT evaluator')){assert.equal(input.visibleEntities.length,count);assert(input.apiCalls.some((c:any)=>c.ok&&c.response.length===count));return reply({pass:true,deficiencies:[]});}
   if(sys.includes('You are the backend workflow'))return reply(decisions++===0?{calls:[{api:'read_items',args:{}}]}:{done:true,summary:'Current complete parcel list',entities:rows,stats:[{label:'Parcels',value:String(count)}]});
   return reply(sys.includes('independently verify')?{pass:true,reason:'Complete fixture read and projection'}:{proceed:true,instructions:'Read the complete current collection',constraints:[],expectedOutcome:'Verified complete collection'});
  };
  await f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Read all current parcels',scope:'All',filter:'All',projectionDisplayMode:false},llm:{model:'fixture-only',chatCompletion}}as any);
  assert.equal(JSON.parse(f.stored().runtime_state_json).entities.length,count);assert.equal(JSON.parse(f.stored().runtime_state_json).projectionDisplayMode,'complete-grounded');if(count===25)assert.equal(JSON.parse(f.stored().runtime_state_json).entities.filter((row:any)=>row.name==='Shared parcel').length,2);
  const reopened=await f.reopen().queryState({user:'fixture-owner'});const app=reopened.apps[0];assert.equal(app.runtimeState.entities.length,count);assert.equal(app.runtimeState.projectionDisplayMode,'complete-grounded');assert.equal(app.appPackage.ui.meta.a2ui.initialData.entities.length,count);assert.equal(app.appPackage.ui.meta.a2ui.initialData.draft.statValue,String(count));
});

test('payload claiming complete display cannot publish failed business evidence or change persisted mode',async t=>{
 const f=await viewRuntimeFixture(t,[]);let decisions=0;const llm={model:'fixture',chatCompletion:async(request:any)=>{const sys=request.messages[0].content;if(sys.includes('You analyze a GUI'))return reply({objective:'Read current parcels',deliverables:[]});if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:false,deficiencies:['Required business read-back remains unverified']});if(sys.includes('You are the backend workflow'))return reply(decisions++===0?{calls:[{api:'read_items',args:{}}]}:{done:true,summary:'Not independently verified',entities:[],stats:[]});return reply({proceed:true,instructions:'Read current parcels only',constraints:[],expectedOutcome:'Verified current list'});}};
 await assert.rejects(f.runtime.action({appId:'parcels',actionId:'refresh.run',user:'fixture-owner',eventPayload:{subject:'Read current parcels',scope:'All',filter:'All',projectionDisplayMode:'complete-grounded'},llm}as any),/did not pass verification/);
 assert.equal(JSON.parse(f.stored().runtime_state_json).projectionDisplayMode,false);assert.equal(JSON.parse(f.stored().runtime_state_json).entities.length,1);const app=(await f.reopen().queryState({user:'fixture-owner'})).apps[0];assert.equal(app.runtimeState.projectionDisplayMode,false);assert.equal(app.appPackage.ui.meta.a2ui.initialData.entities.length,1);
});

test('unverified legacy recommendation window stays capped and cannot claim complete-grounded on reload',async t=>{
 const rows=Array.from({length:31},(_,i)=>({id:String(i),name:'Legacy item '+i,detail:'Unverified prior window'}));const f=await viewRuntimeFixture(t,[],rows);const app=(await f.reopen().queryState({user:'fixture-owner'})).apps[0];assert.equal(app.runtimeState.projectionDisplayMode,false);assert.equal(app.runtimeState.entities.length,31);assert.equal(app.appPackage.ui.meta.a2ui.initialData.entities.length,30);assert.equal(JSON.parse(f.stored().runtime_state_json).projectionDisplayMode,false);
});
