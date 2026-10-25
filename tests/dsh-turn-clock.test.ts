import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAppWorldBridge} from '../server/appworld-bridge.js';
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
 const bridge:any={getClock:async()=>({dateTime:'2023-05-18T12:00:00',timezone:'unspecified',source:'appworld:/date_time'}),getCapabilities:async()=>tools,callTool:async(id:string)=>({tool:tools.find(x=>x.id===id),response:{records:[{name:'Observed record',historicalDate:'1999-01-01'}],serviceClock:'2032-04-05T06:00:00Z'},dbChanges:null})};
 const result=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:'Complete the record',applicationContext:'{"now":"1999-01-01"}'},appName:'Records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 assert.equal(result?.evaluation?.pass,true);assert.equal(result?.calls.length,3);assert.ok(requests.length>=7);
 for(const r of requests){const system=r.messages[0].content;const match=system.match(/Actual host time for this turn: ([^ ]+) \(UTC\)/);assert.ok(match,system.slice(0,150));assert.ok(Date.parse(match[1])>=before&&Date.parse(match[1])<=Date.now());assert.match(system,/Prefer a current clock returned by the actual service/);assert.match(system,/Authoritative current turn clock: .*2023-05-18T12:00:00/);assert.match(system,/timezone unspecified is service-local wall time/);assert.match(system,/Never borrow another item's historical date/);assert.doesNotMatch(match[1],/1999/);}
 assert.ok(requests.some(r=>r.messages[0].content.includes('Write Verifier')));assert.ok(requests.some(r=>r.messages[1].content.includes('2032-04-05')),'actual service clock remains in observed response history');
 requests.length=0;step=0;bridge.getClock=async()=>{throw Error('clock unavailable')};
 const fallback=await runAppWorldGrounding({bridge,permissions:tools.map(x=>x.permission),payload:{request:'Complete the record',applicationContext:'{"now":"1999-01-01"}'},appName:'Records',llm:{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture'}});
 assert.equal(fallback?.evaluation?.pass,true);for(const r of requests){const system=r.messages[0].content;assert.match(system,/Authoritative current turn clock: .*"source":"host:UTC"/);assert.match(system,/service clock unavailable/);assert.doesNotMatch(system,/Authoritative current turn clock: .*1999/);}

});

test('bridge reads only the real configured service clock and rejects missing or malformed clocks',async t=>{
 let value:any={date_and_time:'2023-05-18T12:00:00'},status=200;const seen:string[]=[];
 const server=http.createServer((req,res)=>{seen.push(req.method+' '+req.url);res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise<void>(r=>server.close(()=>r()))});
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'world-clock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'liveuiagent.config.json'),JSON.stringify({appworld:{enabled:true,apiBase:`http://127.0.0.1:${(server.address() as any).port}`,snapshotRoot:'snapshots'}}));
 const previous={APPWORLD_ENABLED:process.env.APPWORLD_ENABLED,APPWORLD_API_BASE:process.env.APPWORLD_API_BASE};delete process.env.APPWORLD_ENABLED;delete process.env.APPWORLD_API_BASE;t.after(()=>{for(const [k,v] of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;});
 const bridge=createAppWorldBridge(dir)!;assert.deepEqual(await bridge.getClock!(),{dateTime:'2023-05-18T12:00:00',timezone:'unspecified',source:'appworld:/date_time'});
 value={date_and_time:'2030-01-01T08:30:00+08:00'};assert.equal((await bridge.getClock!())?.timezone,'offset');value={date_and_time:'1999 client says now'};assert.equal(await bridge.getClock!(),null);status=404;assert.equal(await bridge.getClock!(),null);assert.deepEqual(seen,['GET /date_time','GET /date_time','GET /date_time','GET /date_time']);
});
