import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {actualGroundingEvidence, attemptedGroundingEvidence, groundingEvidenceHistory, projectBusinessEvidence} from '../server/grounding-evidence.js';

const authenticators=['access_token','accessToken','refresh_token','refreshToken','api_key','apiKey','client_secret','clientSecret','Authorization','password'];
test('exact nested authentication keys are omitted with paths, while business tokens and full text survive',()=>{
 const original={body:'A business document may literally discuss a secret or token.',token:'business-id',token_count:42,secret:'ordinary field',nested:[Object.fromEntries(authenticators.map(key=>[key,'authentication-fixture-secret']))]};
 const projected=projectBusinessEvidence(original,'response');assert.equal((projected.value as any).body,original.body);assert.equal((projected.value as any).token,'business-id');assert.equal((projected.value as any).token_count,42);assert.equal((projected.value as any).secret,'ordinary field');
 assert.deepEqual(projected.omittedAuthenticationKeys,authenticators.map(key=>`response.nested[0].${key}`));assert.doesNotMatch(JSON.stringify(projected.value),/authentication-fixture-secret/);assert.equal(original.nested[0].apiKey,'authentication-fixture-secret','projection must not mutate actual evidence');
 const failed=attemptedGroundingEvidence({api:'write',order:3,attemptedArguments:{value:7,apiKey:'authentication-fixture-secret'},executionState:'outcome_unknown',error:'Response lost'});
 assert.equal(failed.request,undefined,'a proposal/attempt is not a bridge-confirmed actual request');assert.equal(failed.executionState,'outcome_unknown');assert.deepEqual(failed.omittedAuthenticationKeys,['attemptedArguments.apiKey']);assert.equal((failed.attemptedArguments as any).value,7);
});

test('executor, write verifier and evaluator receive full ordered actual email and label evidence',async t=>{
 const body='Invoice details: '+('legitimate long first-message body '.repeat(90));
 const response={thread_id:7,emails:[{id:10,body},{id:11,body:'Client reply: paid today',response_to:10}],labels:['paid'],nested:{accessToken:'authentication-fixture-secret'},token:'ordinary-business-id'};
 const captures:any[]=[];const actual:any[]=[];let decisions=0;
 function hasReply(log:any[]){return log.some(x=>x.api==='show_thread'&&x.response?.emails?.some((mail:any)=>mail.id===11&&mail.response_to===10&&mail.body==='Client reply: paid today'));}
 function hasPaid(log:any[]){return log.some(x=>x.api==='label_thread'&&x.request?.thread_id===7&&x.request?.labels?.includes('paid'));}
 const service=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);captures.push(payload);const system=payload.messages[0].content,input=JSON.parse(payload.messages[1].content);let value;
 if(system.includes('You analyze a GUI'))value={objective:'Verify the actual reply and paid label',deliverables:['The saved thread has the paid label and verified reply']};
 else if(system.includes('You are the Write Verifier'))value={approved:true};
 else if(system.includes('You are an INDEPENDENT evaluator'))value={pass:hasReply(input.apiCalls)&&hasPaid(input.apiCalls),deficiencies:hasReply(input.apiCalls)&&hasPaid(input.apiCalls)?[]:['Missing actual reply or target paid-label evidence']};
 else {decisions++;value=decisions===1?{calls:[{api:'show_thread',args:{thread_id:7}}]}:decisions===2?{calls:[{api:'label_thread',args:{thread_id:7,labels:['paid']}}]}:decisions===3?{calls:[{api:'send_receipt',args:{thread_id:7,to:'client@example.test'}},...Array.from({length:8},()=>({api:'show_thread',args:{thread_id:7}}))]}:{done:true,summary:'Actual reply and paid label verified',entities:[{id:'7',name:'Actual invoice',detail:'Paid; client replied'}]};}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));});
 await new Promise<void>(resolve=>service.listen(0,'127.0.0.1',resolve));t.after(()=>{service.closeAllConnections();return new Promise<void>(resolve=>service.close(()=>resolve()));});
 const tools=['show_thread','label_thread','send_receipt'].map(api=>({id:api,apiName:api,permission:api,appName:'mail',method:api==='show_thread'?'GET':'POST',purpose:'Read thread or write requested mail change'}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{const request={...args,nested:{apiKey:'authentication-fixture-secret'}};const result={tool:tools.find(x=>x.id===id),request,response:id==='show_thread'?response:{message:id==='label_thread'?'Email thread labeled':'Receipt sent'},dbChanges:null};actual.push(actualGroundingEvidence({api:id,order:actual.length+1,request:result.request,response:result.response}));return result;}};
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:'Mark the actual invoice paid and send a receipt after verifying the client reply.'},appName:'Mail records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(service.address() as any).port}/v1`,model:'fixture'}});
 assert.equal(result?.evaluation?.pass,true);assert.equal(actual.length,11);assert.deepEqual(result!.attempts.filter(x=>x.executionState==='succeeded').map(x=>x.order),Array.from({length:11},(_,i)=>i+1));
 const execution=captures.filter(x=>x.messages[0].content.includes('You are the backend workflow')).map(x=>JSON.parse(x.messages[1].content).previousCalls);
 const verifiers=captures.filter(x=>x.messages[0].content.includes('You are the Write Verifier')).map(x=>JSON.parse(x.messages[1].content).previousCalls);
 const evaluator=captures.find(x=>x.messages[0].content.includes('You are an INDEPENDENT evaluator'));
 assert(execution.some(x=>hasReply(x)&&hasPaid(x)),'executor sees actual complete response plus label arguments');assert(verifiers.some(x=>hasReply(x)&&hasPaid(x)),'later write verifier sees the same full prior evidence');assert(hasReply(JSON.parse(evaluator.messages[1].content).apiCalls)&&hasPaid(JSON.parse(evaluator.messages[1].content).apiCalls));
 assert(!JSON.stringify(captures).includes('authentication-fixture-secret'));assert(JSON.stringify(captures).includes('ordinary-business-id'));assert(result!.attempts.some(x=>(x.omittedAuthenticationKeys as string[]|undefined)?.includes('request.nested.apiKey')));assert(result!.attempts.some(x=>(x.omittedAuthenticationKeys as string[]|undefined)?.includes('response.nested.accessToken')));
 // Reproduce the old evidence projection on these same actual API results:
 // response400 loses the second email; older entries lose response AND request.
 const shortened=actual.map(x=>({api:x.api,ok:true,response:JSON.stringify(x.response).slice(0,400)}));const old=[...shortened.slice(0,-8).slice(-12).map(x=>({api:x.api,ok:x.ok})),...shortened.slice(-8)];
 assert.equal(hasReply(old)&&hasPaid(old),false,'old projected evidence cannot verify either required fact');assert.equal(hasReply(groundingEvidenceHistory(actual))&&hasPaid(groundingEvidenceHistory(actual)),true,'new evidence preserves both facts without SQL substitution');
});
