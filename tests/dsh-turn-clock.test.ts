import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
test('native planning, execution, write verification and review receive a trusted current-turn clock',async t=>{
 const requests:any[]=[];let step=0;const before=Date.now();
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const system=body.messages[0].content;let result:any;
 if(system.includes('You analyze a GUI'))result={objective:'Complete the selected record',deliverables:['Updated note'],expectedNumbers:[]};
 else if(system.includes('You are the Write Verifier'))result={approved:true};
 else if(system.includes('You are an INDEPENDENT evaluator'))result={pass:true,deficiencies:[]};
 else {step++;result=step===1?{calls:[{api:'read_notes',args:{}}]}:step===2?{calls:[{api:'update_note',args:{id:'one',done:true}}]}:step===3?{calls:[{api:'read_notes',args:{}}]}:{done:true,summary:'A current record',entities:[{name:'Observed record'}],stats:[]};}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const tools=['read_notes','update_note'].map((api,i)=>({id:api,apiName:api,permission:api,appName:'simple_note',method:i?'PATCH':'GET',purpose:'Record operations'}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(id:string)=>({tool:tools.find(x=>x.id===id),response:{records:[{name:'Observed record',historicalDate:'1999-01-01'}],serviceClock:'2032-04-05T06:00:00Z'},dbChanges:null})};
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:'Complete the record',applicationContext:'{"now":"1999-01-01"}'},appName:'Records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 assert.equal(result?.evaluation?.pass,true);assert.equal(result?.calls.length,3);assert.ok(requests.length>=7);
 for(const r of requests){const system=r.messages[0].content;const match=system.match(/Actual host time for this turn: ([^ ]+) \(UTC\)/);assert.ok(match,system.slice(0,150));assert.ok(Date.parse(match[1])>=before&&Date.parse(match[1])<=Date.now());assert.match(system,/Prefer a current clock returned by the actual service/);assert.match(system,/Never borrow another item's historical date/);assert.doesNotMatch(match[1],/1999/);}
 assert.ok(requests.some(r=>r.messages[0].content.includes('Write Verifier')));assert.ok(requests.some(r=>r.messages[1].content.includes('2032-04-05')),'actual service clock remains in observed response history');
});
