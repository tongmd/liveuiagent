import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {withActionDeadline} from '../server/action-deadline.js';

async function fixture(t:any, decide:(body:any)=>any, dispatch:(id:string,args:any)=>any) {
 const prompts:any[]=[];const operations:any[]=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);prompts.push(body);const system=body.messages[0].content;let value;
 if(system.includes('You analyze a GUI'))value={objective:'Save items and their required relationships',deliverables:['Saved items with required relationships']};
 else if(system.includes('You are the Write Verifier'))value={approved:true};
 else value=decide(body);
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const tools=['read_item','create_item','attach_relation'].map(api=>({id:api,apiName:api,permission:api,appName:'records',method:api==='read_item'?'GET':'POST',purpose:'Read or update actual records'}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{operations.push({id,args});const response=await dispatch(id,args);return{tool:tools.find(x=>x.id===id),response,dbChanges:null};}};
 return {operations,prompts,run:(extra:any={})=>runAppWorldGrounding({bridge,...extra,permissions:tools.map(x=>x.permission),payload:{request:'Save the item and its required relationship. Preserve existing objects.'},appName:'Records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}})};
}
const done={done:true,summary:'Actual item verified',entities:[{id:'saved-1',name:'Actual item',detail:'Saved'}]};
const read=()=>({api:'read_item',args:{id:'saved-1'}});

test('repair can execute after sixteen first-round calls without replaying the successful create',async t=>{
 let decisions=0,reviews=0;const f=await fixture(t,body=>{
  if(body.messages[0].content.includes('You are an INDEPENDENT evaluator'))return ++reviews===1?{pass:false,deficiencies:['Attach the missing relationship to saved-1; the item already exists.']}:{pass:true,deficiencies:[]};
  const input=JSON.parse(body.messages[1].content);decisions++;
  if(input.instruction?.startsWith('You must finish NOW'))return done;
  if(decisions===1)return{calls:[{api:'create_item',args:{name:'Actual item'}},...Array.from({length:9},read)]};
  if(decisions===2)return{calls:Array.from({length:6},read)};
  if(!input.evaluatorDeficiencies)return done;
  if(!f.operations.some(x=>x.id==='attach_relation'))return{calls:[{api:'attach_relation',args:{id:'saved-1',relation:'required'}},read()]};
  return done;
 },()=>({id:'saved-1',name:'Actual item'}));
 const output=await f.run();assert.equal(output?.evaluation?.pass,true);assert.equal(f.operations.length,18);assert.equal(f.operations.filter(x=>x.id==='create_item').length,1);assert.equal(f.operations.filter(x=>x.id==='attach_relation').length,1);
 const repair=f.prompts.filter(p=>p.messages[0].content.includes('You are the backend workflow')).find(p=>JSON.parse(p.messages[1].content).evaluatorDeficiencies);
 assert.match(repair.messages[1].content,/reusing ids and confirmed successful writes/);assert.match(repair.messages[1].content,/Do not replay successful creates or retry an unknown write outcome/);
});

test('a model ignoring finish still cannot dispatch more than 64 actual API attempts',async t=>{
 const f=await fixture(t,body=>body.messages[0].content.includes('You are an INDEPENDENT evaluator')?{pass:false,deficiencies:['More verified items remain.']}:{calls:Array.from({length:10},read)},()=>({id:'saved-1',name:'Actual item'}));
 const output=await f.run();assert.equal(f.operations.length,64);assert.equal(output?.executionEvidence?.attemptedApiCalls,64);assert.equal(output?.evaluation?.pass,false);assert.equal(output?.executionEvidence?.totalApiAttemptLimit,64);
});

test('failed dispatches consume the same hard bound and preserve unknown outcome diagnostics',async t=>{
 const f=await fixture(t,body=>body.messages[0].content.includes('You are an INDEPENDENT evaluator')?{pass:false,deficiencies:['No successful response.']}:{calls:Array.from({length:10},read)},()=>{throw Error('Response was lost after dispatch');});
 const output=await f.run();assert.equal(f.operations.length,64);assert.equal(output?.executionEvidence?.successfulApiCalls,0);assert.equal(output?.executionEvidence?.unknownDispatchOutcomes,64);assert.equal(output?.evaluation?.pass,false);assert.match(output!.evaluation!.deficiencies.join(' '),/64 dispatch attempts, 64 unknown/);assert(output!.attempts.some(x=>x.dispatchOutcome==='unknown'&&x.automaticRetry===false));
});

test('zero proposed calls are evaluated and reported without inventing write-gate rejection',async t=>{
 let reviews=0;const f=await fixture(t,body=>body.messages[0].content.includes('You are an INDEPENDENT evaluator')?(reviews++,{pass:false,deficiencies:['Required ingredients were not supplied; do not invent them.']}):{done:true,summary:'Missing required ingredients',entities:[]},()=>{throw Error('must not dispatch');});
 const output=await f.run();assert.equal(f.operations.length,0);assert.equal(reviews,2);assert.equal(output?.evaluation?.pass,false);assert.equal(output?.executionEvidence?.attemptedApiCalls,0);assert.match(output!.evaluation!.deficiencies.join(' '),/0 dispatch attempts/);assert.doesNotMatch(JSON.stringify(output),/write gates rejected every attempt|nothing was changed/);
});

test('the host absolute action deadline prevents dispatch of the next batch entry',async t=>{
 let now=1000;const f=await fixture(t,()=>({calls:[read(),read()]}),()=>{now=11001;return{id:'saved-1',name:'Actual item'};});
 t.mock.method(Date,'now',()=>now);
 const output=await withActionDeadline(11000,()=>f.run());assert.equal(f.operations.length,1);assert.equal(output?.deadlineExceeded,true);assert.equal(output?.evaluation?.pass,false);assert.match(output!.evaluation!.deficiencies.join(' '),/deadline exceeded/i);
});


test('legal business field content reaches every grounding role without dropping its tail',async t=>{
 const tail='Then attach all three required relationships to the named existing target; preserve 20%.';
 const value='A legitimate user field with detailed context. '.repeat(12)+tail;
 let decisions=0;const f=await fixture(t,body=>body.messages[0].content.includes('You are an INDEPENDENT evaluator')?{pass:true,deficiencies:[]}:++decisions===1?{calls:[{api:'attach_relation',args:{id:'saved-1',relation:'required'}},read()]}:done,()=>({id:'saved-1',name:'Actual item'}));
 const output=await f.run({fields:[{label:'Specific instructions',value}]});assert.equal(output?.evaluation?.pass,true);
 for(const role of ['You analyze a GUI','You are the backend workflow','You are the Write Verifier','You are an INDEPENDENT evaluator']) {
  const messages=f.prompts.filter(p=>p.messages[0].content.includes(role));assert(messages.length>0);for(const body of messages)assert(body.messages[1].content.includes(tail),role+' lost the actual business-field tail');
 }
 assert(!f.prompts.some(p=>p.messages[1].content.includes('currentSubmission')),'no new hidden prompt channel');
});
