import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

// The fixture checks the exact planning/execution/verifier/evaluator contract
// and evidence flow, not whether a real model follows natural-language policy.
for (const scenario of [
 {name:'new shared bill preserves prior debt',request:'Log a new $30 bill for three people including me and request their shares; they still owe earlier charges.',api:'create_expense',amount:30,before:50,after:60,number:'30 / 3 = 10 event share'},
 {name:'explicit partial repayment preserves remaining debt',request:'Alex paid me back $10 of the $50 outstanding. Record that partial repayment.',api:'record_payment',amount:10,before:50,after:40,number:'10 partial repayment'},
]) test(scenario.name,async t=>{
 const prompts:any[]=[];const operations:any[]=[];let step=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);prompts.push(b);const sys=b.messages[0].content;let result:any;
 if(sys.includes('You analyze a GUI'))result={objective:scenario.request,deliverables:[scenario.api],expectedNumbers:[{label:'this event only',value:scenario.number}]};
 else if(sys.includes('You are the Write Verifier'))result={approved:true};
 else if(sys.includes('You are an INDEPENDENT evaluator'))result={pass:true,deficiencies:[]};
 else {step++;result=step===1?{calls:[{api:'read_balance',args:{member:'Alex'}}]}:step===2?{calls:[{api:scenario.api,args:{amount:scenario.amount,member:'Alex'}}]}:step===3?{calls:[{api:'read_balance',args:{member:'Alex'}}]}:{done:true,summary:'Alex balance verified',entities:[{name:'Alex',id:'person1',detail:`Owes $${scenario.after}`}],stats:[{label:'Outstanding',value:String(scenario.after)}]};}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const tools=['read_balance','create_expense','record_payment'].map(api=>({id:api,apiName:api,permission:api,appName:'ledger',method:api==='read_balance'?'GET':'POST',purpose:'Read current balance, create new debt, or record actual repayment'}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{operations.push({id,args});return {tool:tools.find(x=>x.id===id),response:{member:'Alex',id:'person1',balance:operations.length===1?scenario.before:scenario.after},dbChanges:null}}};
 const output=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:scenario.request},appName:'Shared costs',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 assert.deepEqual(operations.map(x=>x.id),['read_balance',scenario.api,'read_balance']);assert.equal(operations[1].args.amount,scenario.amount);assert.equal(output?.evaluation?.pass,true);
 const byRole=(role:string)=>prompts.filter(p=>p.messages[0].content.includes(role));
 const goal=byRole('You analyze a GUI')[0].messages[0].content;
 assert.match(goal,/future reimbursement language/i);assert.match(goal,/does NOT assert that money has already changed hands/);assert.match(goal,/INCREMENT, not the final cumulative balance/);
 const execution=byRole('You are the backend workflow');assert.ok(execution.length>=4);
 for(const p of execution){const s=p.messages[0].content;assert.doesNotMatch(s,/make that write call FIRST|OVERRIDES the button|balance that is too high means/);assert.match(s,/required identifiers, existing targets/);assert.match(s,/baseline plus the signed event change/);assert.match(s,/fallible plan/);assert.match(s,/budget limit is not evidence of success/);}
 const verifier=byRole('You are the Write Verifier')[0];assert.match(verifier.messages[0].content,/event share is not a cumulative balance/);assert.match(verifier.messages[1].content,new RegExp(String(scenario.before)));
 const review=byRole('You are an INDEPENDENT evaluator')[0];assert.match(review.messages[0].content,/mustFinish do not waive/);assert.match(review.messages[0].content,/Do not approve only because execution matched a mistaken goal/);assert.match(review.messages[1].content,new RegExp(String(scenario.after)));
});
