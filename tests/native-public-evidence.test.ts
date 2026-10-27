import test from 'node:test';import assert from 'node:assert/strict';
import {bindPublicCard,prefetchReceipt,isBoundPublicCard,publicPrefetchEvidence} from '../server/public-tool-evidence.js';
import {runActionTools,runAppWorldGrounding} from '../server/liveuiagent.js';
const fact=(results:any[])=>({api:'arxiv_search',ok:true,requestSource:'web-tool-dispatched-arguments',response:{fetchedAt:'2026-10-27T06:00:00.000Z',results}});
const title='A complete long paper title exceeding forty characters and preserving the actual source';
const source={title,url:'https://arxiv.org/abs/2610.12345v1',summary:'Code is https://github.com/example/project'};
test('host binds full source card before legacy clipping and places metadata in Native detail text',()=>{
 const c=bindPublicCard({name:title,detail:'Actual contribution'},[fact([source])])!;
 assert.equal(c.name,title);assert.equal(c.id,source.url);assert.match(c.detail,/Source: https:\/\/arxiv.org/);assert.match(c.detail,/Retrieved: 2026/);assert.match(c.detail,/Code: https:\/\/github.com\/example\/project/);assert.equal(isBoundPublicCard(c),true);
 assert.equal(isBoundPublicCard({...c}),false);assert.equal(bindPublicCard({name:'fake',hostBrand:true,sourceUrl:source.url},[fact([source])]),null);
 assert.equal(bindPublicCard({name:title},[fact([source,{...source,url:'https://arxiv.org/abs/2610.99999v1'}])]),null);
 assert.equal(bindPublicCard({name:title},[{...fact([source]),ok:false}]),null);
});
test('public preflight failure is not network timeout; actual failure and later success remain separate',async()=>{
 const o=globalThis.fetch;globalThis.fetch=async()=>{throw Error('actual network fixture failed');};
 try{const r:any=await runActionTools({steps:[{type:'tool',capability:'tool.web.fetch'},{type:'tool',capability:'tool.arxiv.search'}],permissions:['tool.web.fetch','tool.arxiv.search']},{query:'all:agent'});
 const evidence=publicPrefetchEvidence(r);assert.equal(evidence.length,2);assert.equal(evidence[0].executionState,'preflight_not_started');assert.equal(evidence[1].executionState,'dispatch_failed');assert.equal(evidence.every(x=>x.ok===false),true);
 }finally{globalThis.fetch=o;}
});
test('prefetch receipt preserves original full HTTP response and phase without claiming active success',()=>{
 const receipt=prefetchReceipt({id:'tool.arxiv.search',apiName:'arxiv_search'},{query:'all:agent'},{results:[source]});assert.equal(receipt.phase,'prefetch');assert.equal(receipt.response.results[0].title,title);assert.notEqual(receipt.requestSource,'web-tool-dispatched-arguments');
});

test('actual HTTP producer response survives done normalization and JSON reopen visible detail; prefail and later success both reviewed',async()=>{
 const {createServer}=await import('node:http');let httpCalls=0;
 const xml=`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>${source.url}</id><title>${title}</title><summary>${source.summary}</summary><published>2026-10-27</published><author><name>Alice</name></author></entry></feed>`;
 const server=createServer((req,res)=>{httpCalls++;res.writeHead(200,{'Content-Type':'application/atom+xml'});res.end(xml);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as any).port;const original=globalThis.fetch;globalThis.fetch=async(input:any,init:any)=>{assert.match(String(input),/^https:\/\/export.arxiv.org\/api\/query/);return original(`http://127.0.0.1:${port}/fixture`,init);};
 const before=prefetchReceipt({id:'tool.arxiv.search',apiName:'arxiv_search'},{query:'all:agent'},undefined,Error('actual earlier fixture failure'));let step=0;let reviewed=false;
 const reply=(x:any)=>({choices:[{message:{content:JSON.stringify(x)}}]});
 try{const out:any=await runAppWorldGrounding({permissions:[],webPermissions:['tool.arxiv.search'],prefetchEvidence:[before],payload:{query:'all:agent'},appName:'Paper',llm:{model:'fixture-only',chatCompletion:async(req:any)=>{
 const sys=req.messages[0].content;const inp=JSON.parse(req.messages[1].content.split('\n')[0]);assert.equal(inp.prefetchEvidence[0].executionState,'dispatch_failed');
 if(sys.includes('You analyze a GUI'))return reply({objective:'Read papers',projectionPolicy:'replace_or_filter'});
 if(sys.includes('You are an INDEPENDENT evaluator')){reviewed=true;assert.equal(inp.apiCalls[0].ok,true);assert.equal(inp.prefetchEvidence[0].ok,false);assert.match(inp.visibleEntities[0].detail,/Retrieved:/);assert.equal(inp.visibleEntities[0].name,title);return reply({pass:true,deficiencies:[]});}
 return ++step===1?reply({calls:[{api:'arxiv_search',args:{query:'all:agent'}}]}):reply({done:true,summary:'Actual paper',entities:[{name:title,id:source.url,detail:'Actual contribution'}],stats:[]});
 }}});assert.equal(httpCalls,1);assert.equal(reviewed,true);assert.equal(out.executionEvidence.successfulApiCalls,1);assert.equal(out.evaluation.pass,true);const reopened=JSON.parse(JSON.stringify(out.entities));assert.equal(reopened[0].name,title);assert.match(reopened[0].detail,/https:\/\/arxiv.org\/abs\/2610.12345v1/);assert.match(reopened[0].detail,/Code: https:\/\/github.com\/example\/project/);
 }finally{globalThis.fetch=original;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('same-name local and explicit conflicting business identity never become public IDs',()=>{
 for(const item of [{name:title,id:'123',appRecordId:'record-1'},{name:title,id:'123'},{name:title,id:123},{name:title,id:0},{name:title,appRecordId:'record-1'},{name:title,url:'https://example.com/not-the-source'}]){assert.equal(bindPublicCard(item,[fact([source])]),null);}
 assert.equal(bindPublicCard({name:title,id:'arXiv:2610.12345v1'},[fact([source])])?.id,source.url);
});
