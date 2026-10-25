import test from 'node:test';
import assert from 'node:assert/strict';
import {planAgentApp} from '../server/liveuiagent.js';
import {actionDeadlineError} from '../server/action-deadline.js';

const slots={appName:'Shelves',tagline:'Track your reading',accent:'#426b57',slots:[{label:'Book title',type:'string'},{label:'Reading shelf',type:'string'},{label:'Finish date',type:'date'}],actions:[{label:'Move book',description:'Move a book between shelves'},{label:'Finish book',description:'Finish a book with verdict'},{label:'Remove book',description:'Remove a book from a shelf'}],services:[],itemLabel:'Book',glyph:'📚',metric:'',metricLabel:'Books',collection:'Shelves',tileTagline:'Your reading shelves',actionVerb:'Open'};
async function failPlanning(error:Error) {
 let orchestratorCalls=0;
 const llm={model:'fixture',chatCompletion:async(request:any)=>{
  const system=String(request.messages?.[0]?.content);
  if(system.includes('Orchestrator Agent')){orchestratorCalls++;throw error;}
  const value=system.includes('Business Slot Agent')?slots:{glyph:'<path d="M20 18h56v60H20z" fill="#fff"/>'};
  return{choices:[{message:{content:JSON.stringify(value)}}]};
 }};
 let caught:any;
 try{await planAgentApp('A reading journal with editable shelves',llm);}catch(e){caught=e;}
 assert.ok(caught,'planning must fail');assert.equal(orchestratorCalls,1,'must not replay a rejected inference');return caught;
}

test('native token exhaustion remains an output failure, not a credentials/network prompt',async()=>{
 const original=Object.assign(new Error('Native model output reached its token limit'),{code:'dsh_native_output_truncated',nativeInference:{upstreamStatus:200,finish_reason:'length',completion_tokens:32768}});
 const error=await failPlanning(original);
 assert.equal(error,original);assert.equal(error.code,'dsh_native_output_truncated');assert.equal(error.nativeInference.finish_reason,'length');assert.notEqual(error.status,428);assert.equal(error.requiredConfig,undefined);
});
test('host action deadline preserves its 504 and unknown-effects warning',async()=>{
 const original=actionDeadlineError();const error=await failPlanning(original);
 assert.equal(error,original);assert.equal(error.status,504);assert.match(error.message,/Do not automatically retry writes/);assert.equal(error.requiredConfig,undefined);
});
test('observed native provider rejection still requests credentials; unrelated inference errors do not',async()=>{
 const auth=Object.assign(new Error('Native model provider returned HTTP 401'),{code:'dsh_native_provider_http',nativeInference:{upstreamStatus:401}});
 const rejected=await failPlanning(auth);assert.equal(rejected.status,428);assert.equal(rejected.code,'llm_config_required');assert.match(rejected.message,/provider \(HTTP 401\)/);assert.doesNotMatch(rejected.message,/could not reach/);
 const transport=Object.assign(new Error('Native relay stream interrupted'),{code:'dsh_native_stream_incomplete'});
 assert.equal(await failPlanning(transport),transport);
});
