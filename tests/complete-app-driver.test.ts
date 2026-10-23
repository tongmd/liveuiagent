import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {runCompleteAppEvaluator} from '../server/complete-app-evaluator.js';

const html='<!doctype html><html><head></head><body><h1>Notes</h1><label>Note<input id="note"></label><button id="save">Save</button><p id="result"></p><script>result.textContent=localStorage.getItem("note")||"Empty";save.onclick=()=>{localStorage.setItem("note",note.value);result.textContent=note.value};</script></body></html>';
async function fixture(t:any,decisions:any[],judge:any={passed:true,confidence:1,summary:'Saved note observed after reopen',evidence:['Persisted note appears in reopened UI'],failures:[]}){
  let count=0;const requests:any[]=[];
  const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);requests.push(input);const judging=input.messages[0].content.startsWith('Judge');const value=judging?judge:decisions[count++];res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as {port:number};return {requests,llm:{apiBase:`http://127.0.0.1:${address.port}/v1`,apiKey:'fixture-only',model:'fixture/chosen-evaluator'}};
}
const fill={done:false,action:{kind:'fill',target:'e1',value:'Persisted note'}};
const click={done:false,action:{kind:'click',target:'e2'}};

test('one malformed driver decision is repaired; final judge receives a fresh reopen and raw decisions are retained',async t=>{
  const f=await fixture(t,[{done:false,action:{kind:'execute_script',value:'not allowed'}},fill,click,{done:false,action:{kind:'assert',text:'Persisted note'}},{done:true}]);
  const report=await runCompleteAppEvaluator({appId:'dsh_fixture',appName:'Notes',html,mode:'behavior',expectedBehaviorPrompt:'Save Persisted note and show it after reopening',llm:f.llm});
  assert.equal(report.passed,true);assert.equal(report.decisionRepairs,1);assert.equal(report.reopenedForJudgment,true);assert.equal(report.evaluatorModel,'fixture/chosen-evaluator');
  assert.ok(report.after.visibleText.includes('Persisted note'));assert.equal(report.observations.at(-1).source,'evaluator');
  const judge=JSON.parse(f.requests.at(-1).messages[1].content);assert.equal(judge.reopenedForJudgment,true);assert.ok(judge.after.visibleText.includes('Persisted note'));
  const repair=JSON.parse(f.requests[1].messages[1].content);assert.match(repair.repair.validationError,/unsupported/);
  const raw=JSON.parse(await fs.readFile(report.artifactsDir+'/decision-01.json','utf8'));assert.match(raw.raw,/execute_script/);assert.match(raw.validationError,/unsupported/);
  assert.ok(report.decisions.some(item=>item.label==='judge-decision'));
});

test('invalid decision and invalid repair return a failed report without judging or disguising completed actions',async t=>{
  const f=await fixture(t,[fill,click,{done:false,action:{kind:'assert'}},'not valid JSON']);
  const report=await runCompleteAppEvaluator({appId:'dsh_fixture',appName:'Notes',html,mode:'behavior',expectedBehaviorPrompt:'Save and reopen a note',llm:f.llm});
  assert.equal(report.passed,false);assert.equal(report.status,'failed');assert.equal(report.decisionRepairs,1);assert.equal(report.reopenedForJudgment,true);
  assert.deepEqual(report.observations.slice(0,2).map(item=>[item.step.kind,item.ok]),[['fill',true],['click',true]]);
  assert.match(report.verdict.failures.join(' '),/decision remained invalid.*invalid JSON/);assert.equal(f.requests.length,4);assert.ok(!f.requests.some(item=>item.messages[0].content.startsWith('Judge')));
  assert.equal(JSON.parse(await fs.readFile(report.artifactsDir+'/decision-03-repair.json','utf8')).raw,'not valid JSON');
  assert.equal(JSON.parse(await fs.readFile(report.artifactsDir+'/report.json','utf8')).passed,false);
});

test('model assertions are real read-only checks and an assertion failure cannot become a pass',async t=>{
  const f=await fixture(t,[{done:false,action:{kind:'assert',storeKey:'missing',equals:'invented'}}]);
  const report=await runCompleteAppEvaluator({appId:'dsh_fixture',appName:'Notes',html,mode:'behavior',expectedBehaviorPrompt:'Verify stored result',llm:f.llm});
  assert.equal(report.passed,false);assert.match(report.verdict.failures.join(' '),/Assertion failed/);assert.equal(report.decisionRepairs,0);assert.equal(f.requests.length,1);
});

test('unambiguous action.type aliases and missing done normalize without consuming the repair budget',async t=>{
  const f=await fixture(t,[{thought:'fill field',action:{type:'fill',target:'e1',value:'Persisted note'}},{action:{type:'click',target:'e2'}},{done:true}]);
  const report=await runCompleteAppEvaluator({appId:'dsh_fixture',appName:'Notes',html,mode:'behavior',expectedBehaviorPrompt:'Save and reopen Persisted note',llm:f.llm});
  assert.equal(report.passed,true);assert.equal(report.decisionRepairs,0);assert.equal(f.requests.length,4);
  const record=JSON.parse(await fs.readFile(report.artifactsDir+'/decision-01.json','utf8'));
  assert.equal(record.parsed.done,undefined);assert.equal(record.parsed.action.kind,undefined);assert.equal(record.parsed.action.type,'fill');
  assert.equal(record.normalized.done,false);assert.equal(record.normalized.action.kind,'fill');assert.equal(record.normalizations.length,2);
});

test('conflicting action.kind and action.type are rejected and cannot execute before repair',async t=>{
  const conflict={done:false,action:{kind:'click',type:'fill',target:'e2',value:'ambiguous'}};
  const f=await fixture(t,[conflict,conflict]);
  const report=await runCompleteAppEvaluator({appId:'dsh_fixture',appName:'Notes',html,mode:'behavior',expectedBehaviorPrompt:'Save a note',llm:f.llm});
  assert.equal(report.passed,false);assert.equal(report.decisionRepairs,1);assert.match(report.verdict.failures.join(' '),/conflicts/);
  assert.ok(report.observations.every(item=>item.source==='evaluator'));assert.deepEqual(report.finalStore,{});assert.equal(f.requests.length,2);
});
