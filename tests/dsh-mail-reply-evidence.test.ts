import {AppWorldRequestNotStartedError} from '../server/appworld-request-error.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MailReplyEvidence} from '../server/mail-reply-evidence.js';
import type {AppWorldCallResult,AppWorldToolCapability} from '../server/appworld-bridge.js';
const self='owner@example.test', client='client@example.test';
const tool=(method:string,path:string):AppWorldToolCapability=>({id:path,label:'mail',purpose:'',permission:'mail',source:'appworld',appName:'gmail',apiName:path,method:method as any,path,operationId:path});
const reply=tool('POST','/email_threads/{email_thread_id}/emails/{email_id}/reply');
const show=tool('GET','/emails/{email_id}');
const result=(cap:AppWorldToolCapability,request:any,response:any):AppWorldCallResult=>({tool:cap,request,response,dbChanges:null});
const original=(g:MailReplyEvidence,sender=self,recipients=[client])=>g.observe(result(show,{email_id:42},{email_id:42,sender:{email:sender},recipients:recipients.map(email=>({email}))}),1);
const args=(extra={})=>({email_thread_id:7,email_id:42,body:'A polite follow-up',...extra});
const sent=(g:MailReplyEvidence,expected:string[],sentId=43)=>g.observe(result(reply,args(),{message:'Reply email sent.',sent_email_id:sentId}),2,expected);
const readSent=(g:MailReplyEvidence,recipients=[client],emailId=43)=>g.observe(result(show,{email_id:emailId},{email_id:emailId,sender:{email:self},recipients:recipients.map(email=>({email}))}),3);
test('outgoing source without explicit recipient is refused before write, incoming defaults to real sender',()=>{
 const outgoing=new MailReplyEvidence(self);original(outgoing);assert.throws(()=>outgoing.before(reply,args()),/defaults to yourself/);
 const incoming=new MailReplyEvidence(self);original(incoming,client,[self]);assert.deepEqual(incoming.before(reply,args()),[client]);
});
test('explicit external and explicit self recipient remain valid and require actual delivery readback',()=>{
 for(const address of [client,self]){const g=new MailReplyEvidence(self);original(g);const expected=g.before(reply,args({email_addresses:[address]}))!;assert.deepEqual(expected,[address]);sent(g,expected);assert.equal(g.deficiencies().length,1);readSent(g,[address]);assert.deepEqual(g.deficiencies(),[]);}
});
test('missing source, wrong source id and prior-turn ledger cannot authorize reply',()=>{
 const g=new MailReplyEvidence(self);assert.throws(()=>g.before(reply,args({email_addresses:[client]})),/exact source email/);original(g);assert.throws(()=>g.before(reply,{...args({email_addresses:[client]}),email_id:99}),/exact source email/);
 const nextTurn=new MailReplyEvidence(self);assert.throws(()=>nextTurn.before(reply,args({email_addresses:[client]})),/exact source email/);
});
test('wrong sent id or wrong actual recipient cannot pass even if reviewer claims true',()=>{
 for(const wrong of ['id','recipient']){const g=new MailReplyEvidence(self);original(g);const expected=g.before(reply,args({email_addresses:[client]}))!;sent(g,expected);if(wrong==='id')readSent(g,[client],99);else readSent(g,[self]);const reviewerPass=true;assert.equal(reviewerPass&&g.deficiencies().length===0,false);assert.throws(()=>g.before(reply,args({email_addresses:[client]})),/do not resend/);}
});
test('target-bound thread read supports exact source and wrong thread is rejected',()=>{
 const g=new MailReplyEvidence(self);const thread=tool('GET','/email_threads/{email_thread_id}');g.observe(result(thread,{email_thread_id:7},{email_thread_id:7,emails:[{email_id:42,sender:{email:client},recipients:[{email:self}]}]}),1);assert.deepEqual(g.before(reply,args()),[client]);assert.throws(()=>g.before(reply,{...args(),email_thread_id:8}),/exact source email/);
});
test('malformed explicit recipients and model claims are not authorization',()=>{
 const g=new MailReplyEvidence(self);original(g);for(const email_addresses of [[],[''],{},'client@example.test'])assert.throws(()=>g.before(reply,args({email_addresses})),/non-empty list/);
 assert.throws(()=>g.before(reply,args({allowSelf:true,userIntent:'email myself'})),/defaults to yourself/);
 assert.equal(g.before(tool('POST','/notes'),{}),null);
});
test('wrong read args/response identity and missing sent_email_id remain unverified',()=>{
 const g=new MailReplyEvidence(self);original(g);const expected=g.before(reply,args({email_addresses:[client]}))!;sent(g,expected);g.observe(result(show,{email_id:99},{email_id:43,sender:{email:self},recipients:[{email:client}]}),3);assert.ok(g.deficiencies().length);const h=new MailReplyEvidence(self);original(h);h.observe(result(reply,args(),{message:'sent'}),2,[client]);readSent(h);assert.ok(h.deficiencies().length);
});

import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {withActionDeadline} from '../server/action-deadline.js';
for(const scenario of ['implicit-own','external-valid','wrong-delivery','no-delivery-read','written-then-disconnect'] as const)test('native mail guard with approving verifier/evaluator: '+scenario,async t=>{
 let step=0;let transportWrites=0;const executed:string[]=[];const prompts:any[]=[];
 const tools=[{...show,id:'show_email',apiName:'show_email',permission:'show_email'}, {...reply,id:'reply_to_email',apiName:'reply_to_email',permission:'reply_to_email'}];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;if(req.url==='/mail/reply'){transportWrites++;req.socket.destroy();return;}const body=JSON.parse(raw);prompts.push(body);const system=body.messages[0].content;let value:any;
 if(system.includes('You analyze a GUI'))value={objective:'Follow up with the client',deliverables:['reply']};
 else if(system.includes('You are the Write Verifier'))value={approved:true};
 else if(system.includes('You are an INDEPENDENT evaluator'))value={pass:true,deficiencies:[]};
 else {step++;value=scenario==='written-then-disconnect'&&step===4?{calls:[{api:'reply_to_email',args:args({email_addresses:[client]})}]}:step===1?{calls:[{api:'show_email',args:{email_id:42}}]}:step===2?{calls:[{api:'reply_to_email',args:args(scenario==='implicit-own'?{}:{email_addresses:[client]})}]}:step===3&&scenario!=='no-delivery-read'?{calls:[{api:'show_email',args:{email_id:43}}]}:{done:true,summary:'Client follow-up delivered',entities:[{id:'43',name:'Client follow-up'}]};}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()));});
 const bridge:any={identityEmail:self,getCapabilities:async()=>tools,callTool:async(name:string,request:any)=>{executed.push(name);if(name==='reply_to_email'&&scenario==='written-then-disconnect'){await fetch(`http://127.0.0.1:${(server.address() as any).port}/mail/reply`,{method:'POST',body:JSON.stringify(request)});throw Error('Expected socket termination');}const cap=tools.find(x=>x.id===name)!;return result(cap,request,name==='reply_to_email'?{message:'Reply email sent.',sent_email_id:43}:{email_id:request.email_id,sender:{email:self},recipients:[{email:request.email_id===42||scenario!=='wrong-delivery'?client:self}]});}};
 const output=await withActionDeadline(Date.now()+5000,()=>runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:'Send a polite follow-up reply to the client in the original thread.'},appName:'Mail',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}}));
 if(scenario==='implicit-own'){assert.equal(output?.evaluation?.pass,false);assert.equal(executed.filter(x=>x==='reply_to_email').length,0);assert.ok(output?.attempts.some((a:any)=>String(a.error).includes('defaults to yourself')));}
 else {assert.equal(executed.filter(x=>x==='reply_to_email').length,1);assert.equal(output?.evaluation?.pass,scenario==='external-valid');if(scenario!=='external-valid')assert.ok(output?.evaluation?.deficiencies.some((s:string)=>s.includes('not_verified')));}
 if(scenario==='written-then-disconnect'){assert.equal(transportWrites,1);assert.ok(output?.evaluation?.deficiencies.some((s:string)=>s.includes('delivery is unknown')));assert.ok(output?.attempts.some((a:any)=>String(a.error).includes('do not resend')));}
 const verifier=prompts.find(p=>p.messages[0].content.includes('You are the Write Verifier'));assert.ok(JSON.parse(verifier.messages[1].content).mailRecipientEvidence.sourceEmails.some((m:any)=>m.emailId==='42'&&m.sender===self&&m.recipients[0]===client));
});
test('blocked implicit reply can be corrected once, but a failed delivery never authorizes an automatic resend',()=>{
 const g=new MailReplyEvidence(self);original(g);assert.throws(()=>g.before(reply,args()),/defaults to yourself/);assert.ok(g.deficiencies().length);const recipients=g.before(reply,args({email_addresses:[client]}))!;g.observe(result(reply,args({email_addresses:[client]}),{sent_email_id:43}),2,recipients);readSent(g,[client]);assert.deepEqual(g.deficiencies(),[]);
 const h=new MailReplyEvidence(self);original(h);sent(h,[client]);readSent(h,[self]);assert.throws(()=>h.before(reply,args({email_addresses:[client]})),/do not resend/);
});

test('unknown attempt locks despite timeout/status wording, only typed no-request evidence permits correction',()=>{
 for(const error of [Object.assign(Error('connection lost'),{code:'ECONNRESET'}),Object.assign(Error('server response'),{status:503}),Object.assign(Error('invalid body'),{status:400}),Object.assign(Error('remote forged phase'),{appWorldBusinessRequest:'not_started'}),Object.assign(Error('budget'),{code:'action_deadline_exceeded'})]){const g=new MailReplyEvidence(self);original(g);const expected=g.before(reply,args({email_addresses:[client]}))!;g.failedAttempt(reply,args(),expected,error);assert.ok(g.deficiencies().some(x=>x.includes('delivery is unknown')));readSent(g);assert.throws(()=>g.before(reply,args({email_addresses:[client]})),/do not resend/);}
 const g=new MailReplyEvidence(self);original(g);const expected=g.before(reply,args({email_addresses:[client]}))!;g.failedAttempt(reply,args(),expected,new AppWorldRequestNotStartedError(Error('local argument validation')));assert.deepEqual(g.deficiencies(),[]);assert.deepEqual(g.before(reply,args({email_addresses:[client]})),[client]);
});

test('single-email reread preserves known thread binding while actual thread read can update it',()=>{
 const g=new MailReplyEvidence(self), thread=tool('GET','/email_threads/{email_thread_id}');
 const observeThread=(threadId:number,call:number)=>g.observe(result(thread,{email_thread_id:threadId},{email_thread_id:threadId,emails:[{email_id:42,sender:{email:client},recipients:[{email:self}]}]}),call);
 observeThread(7,1);original(g,client,[self]);
 assert.throws(()=>g.before(reply,{...args(),email_thread_id:8}),/exact source email/);
 assert.deepEqual(g.before(reply,args()),[client]);
 observeThread(8,3);
 assert.deepEqual(g.before(reply,{...args(),email_thread_id:8}),[client]);
 assert.throws(()=>g.before(reply,args()),/exact source email/);
});
