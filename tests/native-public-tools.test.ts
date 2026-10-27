import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveToolCapabilities, isWebCapabilityDenied, runAppWorldGrounding} from '../server/liveuiagent.js';
import {findWebToolByApiName} from '../server/web-tools.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});

test('public research grants search and readable pages; explicit prohibition applies to all public tools',()=>{
 const ids=deriveToolCapabilities('搜索 GitHub 开源项目及 arxiv 论文',[]).map(x=>x.id);
 for(const id of ['tool.web.search','tool.web.fetch','tool.github.search','tool.arxiv.search'])assert.ok(ids.includes(id));
 assert.deepEqual(deriveToolCapabilities('不要联网搜索 GitHub 和 arxiv 论文',[]),[]);
 assert.equal(isWebCapabilityDenied('do not use the internet','tool.github.search'),true);
});

test('web-only grounding actually dispatches authorized tools and exposes source evidence to independent review',async()=>{
 const original=globalThis.fetch;let networkCalls=0,steps=0,reviewed=false;
 globalThis.fetch=async(input:any)=>{networkCalls++;assert.match(String(input),/^https:\/\/api.github.com\/search\/repositories\?/);return new Response(JSON.stringify({items:[{full_name:'example/real',html_url:'https://github.com/example/real',description:'Actual HTTP fixture response',stargazers_count:7,language:'TypeScript',updated_at:'2026-10-27'}]}),{status:200});};
 try {
 const output=await runAppWorldGrounding({permissions:[],webPermissions:['tool.github.search'],payload:{query:'agent'},appName:'Repository watch',llm:{model:'fixture-only',chatCompletion:async(request:any)=>{
  const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split('\n')[0]);
  if(sys.includes('You analyze a GUI'))return reply({objective:'Find repositories',deliverables:['Actual repository links'],projectionPolicy:'replace_or_filter'});
  if(sys.includes('You are an INDEPENDENT evaluator')){reviewed=true;assert.equal(input.apiCalls[0].requestSource,'web-tool-dispatched-arguments');assert.equal(input.apiCalls[0].response.results[0].stars,7);return reply({pass:true,deficiencies:[]});}
  assert.match(sys,/github_search_repositories/);assert.doesNotMatch(sys,/- weather_query/);
  return ++steps===1?reply({calls:[{api:'github_search_repositories',args:{query:'agent'}}]}):reply({done:true,summary:'Found example/real on GitHub',entities:[{name:'example/real',id:'https://github.com/example/real',detail:'7 stars'}],stats:[]});
 }}});
 assert.equal(networkCalls,1);assert.equal(reviewed,true);assert.equal(output?.evaluation?.pass,true);
 assert.equal(output?.executionEvidence?.successfulApiCalls,1);assert.equal(output?.attempts[0].requestSource,'web-tool-dispatched-arguments');
 }finally{globalThis.fetch=original;}
});

test('a public-tool call outside the declared permission subset never reaches the network',async()=>{
 const original=globalThis.fetch;let networkCalls=0,steps=0;
 globalThis.fetch=async()=>{networkCalls++;throw new Error('must not dispatch');};
 try{
 const output=await runAppWorldGrounding({permissions:[],webPermissions:['tool.github.search'],payload:{query:'agent'},appName:'Restricted',llm:{model:'fixture-only',chatCompletion:async(request:any)=>{
  const sys=request.messages[0].content;
  if(sys.includes('You analyze a GUI'))return reply({objective:'Search',projectionPolicy:'unspecified'});
  if(sys.includes('You are an INDEPENDENT evaluator'))return reply({pass:false,deficiencies:['No successful evidence']});
  return ++steps===1?reply({calls:[{api:'weather_query',args:{location:'Shanghai'}}]}):reply({done:true,summary:'Unavailable',entities:[],stats:[]});
 }}});
 assert.equal(networkCalls,0);assert.equal(output?.evaluation?.pass,false);
 }finally{globalThis.fetch=original;}
});

test('structured paper search preserves real Atom provenance and honest empty results',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1234.5678</id><title>A &amp; B</title><summary>Actual abstract</summary><published>2026-10-27</published><author><name>Alice</name></author></entry></feed>');
 try{const result:any=await findWebToolByApiName('arxiv_search')!.invoke({query:'all:agent'});assert.equal(result.results[0].title,'A & B');assert.deepEqual(result.results[0].authors,['Alice']);assert.equal(result.source,'arXiv Atom API');}finally{globalThis.fetch=original;}
});

test('page redirects are revalidated before network access and URL credentials/private literals rejected',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('',{status:302,headers:{location:'http://127.0.0.1/internal'}});};
 try{
 const tool=findWebToolByApiName('web_fetch')!;
 await assert.rejects(tool.invoke({url:'https://example.com'}),/private/);assert.equal(calls,1);
 for(const url of ['http://[::1]/','http://[::ffff:127.0.0.1]/','http://100.64.0.1/','http://user:secret@example.com/'])await assert.rejects(tool.invoke({url}),/private|credentials/);
 assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
