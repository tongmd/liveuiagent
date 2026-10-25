import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

const batch=[{api:'update_note',args:{id:'one',text:'original'}},{api:'update_note',args:{id:'two',text:'original'}}];
const correction=batch.map(call=>({...call,args:{...call.args,text:'corrected'}}));
const variants=[
 {name:'strict boolean approval',verdict:{approved:true},expected:2,text:'original'},
 {name:'complete same-API correction',verdict:{approved:false,correctedCalls:correction},expected:2,text:'corrected'},
 {name:'null',verdict:null,expected:0},
 {name:'missing approval',verdict:{reason:'No approval supplied'},expected:0},
 {name:'string false',verdict:{approved:'false'},expected:0},
 {name:'string true',verdict:{approved:'true'},expected:0},
 {name:'false without correction',verdict:{approved:false,reason:'No verified arguments'},expected:0},
 {name:'partial correction',verdict:{approved:false,correctedCalls:correction.slice(0,1)},expected:0},
 {name:'reordered APIs',mixedApis:true,verdict:{approved:false,correctedCalls:[{api:'create_note',args:{id:'two',text:'corrected'}},correction[0]]},expected:0},
 {name:'wrong API correction',verdict:{approved:false,correctedCalls:[{...correction[0],api:'read_notes'},correction[1]]},expected:0},
 {name:'missing required correction field',verdict:{approved:false,correctedCalls:[{...correction[0],args:{text:'missing id'}},correction[1]]},expected:0},
 {name:'array arguments',verdict:{approved:false,correctedCalls:[{...correction[0],args:[]},correction[1]]},expected:0},
 {name:'explicit rejection overrides correction',verdict:{approved:false,reject:true,reason:'Wrong API family',correctedCalls:correction},expected:0},
 {name:'malformed rejection field',verdict:{approved:true,reject:'false'},expected:0},
 {name:'contradictory true and reject',verdict:{approved:true,reject:true,reason:'Do not execute'},expected:0},
 {name:'two actual verifier request timeouts',verdict:{approved:true},timeout:true,expected:0},
 {name:'readonly does not need write approval',verdict:{approved:false},readonly:true,expected:0},
];
for(const variant of variants)test('write verifier fails closed: '+variant.name,async t=>{
 let step=0,verifierRequests=0;const operations:any[]=[],executorInputs:any[]=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const system=body.messages[0].content;let value:any;
 if(system.includes('You analyze a GUI'))value={objective:'Update the actual records',deliverables:['Actual notes'],expectedNumbers:[]};
 else if(system.includes('You are the Write Verifier')){verifierRequests++;if(variant.timeout)await new Promise(r=>setTimeout(r,160));value=variant.verdict;}
 else if(system.includes('You are an INDEPENDENT evaluator'))value={pass:true,deficiencies:[]};
 else {executorInputs.push(JSON.parse(body.messages[1].content));step++;value=step===1?{calls:variant.readonly?[{api:'read_notes',args:{}}]:variant.mixedApis?[batch[0],{...batch[1],api:'create_note'}]:batch}:step===2?{calls:[{api:'read_notes',args:{}}]}:{done:true,summary:'Actual notes read back',entities:[{name:'Actual note',id:'one'}],stats:[]};}
 if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const old=process.env.LIVEUIAGENT_ORCHESTRATOR_TIMEOUT_MS;t.after(()=>old===undefined?delete process.env.LIVEUIAGENT_ORCHESTRATOR_TIMEOUT_MS:process.env.LIVEUIAGENT_ORCHESTRATOR_TIMEOUT_MS=old);
 const tools=[{id:'create_note',apiName:'create_note',permission:'write',appName:'simple_note',method:'POST',purpose:'Create actual note',requiredParams:['id','text']},{id:'update_note',apiName:'update_note',permission:'write',appName:'simple_note',method:'PATCH',purpose:'Update actual note',requiredParams:['id','text']},{id:'read_notes',apiName:'read_notes',permission:'read',appName:'simple_note',method:'GET',purpose:'Read actual notes'}];
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string,args:any)=>{operations.push({id,args});return{tool:tools.find(tool=>tool.id===id),request:args,response:{id:'one',name:'Actual note'},dbChanges:null}}};
 const result=await runAppWorldGrounding({bridge,permissions:['write','read'],payload:{request:'Update actual notes'},appName:'Notes',llm:{...(variant.timeout?{onProgress:(label:string)=>{process.env.LIVEUIAGENT_ORCHESTRATOR_TIMEOUT_MS=label==='Write Verifier Agent'?'80':String(old||60000)}}:{}),apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 const writes=operations.filter(op=>op.id!=='read_notes');assert.equal(writes.length,variant.expected);
 if(variant.expected)assert(writes.every(op=>op.args.text===variant.text));
 assert.equal(verifierRequests,variant.readonly?0:variant.name==='null'||variant.timeout?2:1);
 assert.ok(operations.some(op=>op.id==='read_notes'),'rejected writes do not disable subsequent authorized reads');
 assert.equal(result?.calls.filter(call=>call.tool.method!=='GET').length,variant.expected,'evidence contains only real executed writes');
 if(!variant.expected&&!variant.readonly){assert.ok(result?.attempts.some(attempt=>attempt.api==='(write-verifier)'&&attempt.ok===false));assert.ok(executorInputs.slice(1).some(input=>JSON.stringify(input).includes('write batch rejected:')),'executor receives the actual closed-gate reason');}
});
