import test from 'node:test';import assert from 'node:assert/strict';
import{normalizeGroundingEntities}from'../server/grounding-entities.js';
import{runAppWorldGrounding}from'../server/liveuiagent.js';
import{AppWorldRequestNotStartedError}from'../server/appworld-request-error.js';
const name='A complete  member title longer than forty characters, with exact spacing';
const echoes=new Set([name]);const raw=[{name}];
test('only literal full names in JSON string values avoid echo suppression; no IDs or membership are manufactured',()=>{
 assert.deepEqual(normalizeGroundingEntities(raw,echoes,[],[]),[]);
 for(const response of [{[name]:'unrelated value'},{body:name.toLowerCase()},{body:name.slice(0,40)},{body:'A complete member title longer than forty characters, with exact spacing'},123])assert.deepEqual(normalizeGroundingEntities(raw,echoes,[],[],[response]),[]);
 const response={note:{content:`Historical mention: ${name}; another title is Second full title. These mentions do not establish collection membership.`}};
 const rows=normalizeGroundingEntities([...raw,{name:'Second full title'}],new Set([name,'Second full title']),[],[],[response]);
 assert.deepEqual(rows,[{name},{name:'Second full title'}]);assert(rows.every(row=>!Object.hasOwn(row,'id')&&!Object.hasOwn(row,'appRecordId')));
 assert.deepEqual(normalizeGroundingEntities([{name,provenance:{readonlyExternalReadResponses:[{name}]}}],echoes,[],[]),[],'model-authored provenance is ignored');
});

for(const mode of ['fresh-evaluator-pass','fresh-evaluator-reject','stale-before-write','failed-read','write-response-only','read-only']as const)test(`host successful external read name association retains independent evaluation: ${mode}`,async()=>{
 const tools=['read_before','write_note','read_after','read_failure'].map(api=>({id:api,source:'appworld',apiName:api,permission:api,appName:'fixture_service',method:api==='write_note'?'POST':'GET',purpose:api,inputSchema:{type:'object'}}));
 let writeCount=0,decisions=0,evaluations=0;const dispatched:string[]=[];const evaluatorNames:string[][]=[];
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{dispatched.push(api);if(api==='write_note')writeCount++;if(api==='read_failure')throw new AppWorldRequestNotStartedError(new Error('Controlled failed read: '+name));
  const body=api==='read_before'||api==='write_note'||mode.startsWith('fresh')||mode==='read-only'?{container:{body:`The actual note contains ${name}.`}}:{container:{body:'An unrelated object'}};
  return{tool:tools.find(tool=>tool.id===api),request:args,response:body,dbChanges:null};}};
 const requests=mode==='read-only'?[{api:'read_before',args:{}}]:[
  ...(mode==='stale-before-write'?[{api:'read_before',args:{}}]:[]),{api:'write_note',args:{title:name}},
  ...(mode==='failed-read'?[{api:'read_failure',args:{}}]:[]),{api:'read_after',args:{}}];
 const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),payload:{title:name},appName:'Notes fixture',appPurpose:'Maintain actual note entries',viewContext:{primaryMembership:'service_collection',itemLabel:'Entry',perItemActions:[]},llm:{model:'controlled-no-provider',chatCompletion:async(request,options)=>{
  const role=options?.roleLabel;
  if(role==='Grounding Requirement Agent')return reply({objective:'Inspect the actual requested note entry',projectionPolicy:'retain_existing',deliverables:[],expectedNumbers:[]});
  if(role==='Write Verifier Agent')return reply({approved:true});
  if(role==='Grounding Evaluator Agent'){evaluations++;const packet=JSON.parse(request.messages[1].content);evaluatorNames.push(packet.visibleEntities.map((row:any)=>row.name));assert(packet.visibleEntities.every((row:any)=>!Object.hasOwn(row,'id')));return reply({pass:mode==='fresh-evaluator-pass'||mode==='read-only',deficiencies:['A literal mention alone does not establish requested primary membership']});}
  assert.equal(role,'AppWorld Grounding Agent');decisions++;return reply(decisions===1?{calls:requests}:{done:true,summary:'Observed response, subject to independent verification',entities:[{name}],stats:[]});
 }}});
 assert(result);assert(evaluations>0);assert.equal(writeCount,mode==='read-only'?0:1,'read/evaluation repair never repeats the write');assert.deepEqual(dispatched,requests.map(r=>r.api));
 const associated=mode.startsWith('fresh')||mode==='read-only';assert(evaluatorNames.every(names=>associated?names.includes(name):names.length===0));assert.equal(result.entities.length,associated?1:0);if(associated){assert.equal(result.entities[0].name,name);assert.equal(result.entities[0].id,undefined);}
 assert.equal(result.evaluation?.pass,mode==='fresh-evaluator-pass'||mode==='read-only','name association cannot override a rejecting independent evaluator');
 if(mode==='failed-read')assert.equal(result.calls.some(call=>call.tool.apiName==='read_failure'),false,'failed bridge call never supplies a response');
});
