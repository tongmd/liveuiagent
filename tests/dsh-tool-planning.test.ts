import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {planAppWorldToolPermissions,planAppWorldServices} from '../server/liveuiagent.js';

test('DSH uses the native semantic service selection once, retaining only selected-service and meta permissions',async t=>{
 const requests:any[]=[];
 const response={appName:'Shelves',tagline:'Track your reading',accent:'#426b57',slots:[{label:'Book title',type:'string'},{label:'Reading shelf',type:'string'},{label:'Finish date',type:'date'}],actions:[{label:'Move book',description:'Move a book between shelves'},{label:'Finish book',description:'Finish a book with verdict'},{label:'Remove book',description:'Remove a book from a shelf'}],services:['simple_note'],itemLabel:'Book',glyph:'📚',metric:'3',metricLabel:'Books',collection:'Shelves',tileTagline:'Your reading shelves',actionVerb:'Open'};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const permissions=['tool.appworld.simple_note.update_note','tool.appworld.todoist.create_task','tool.appworld.db.snapshot'];
 const bridge:any={getAppDescriptions:async()=>[{name:'simple_note',description:'Notes'},{name:'todoist',description:'Tasks'}],getCapabilities:async()=>permissions.map((id,i)=>({id,permission:id,source:'appworld',appName:['simple_note','todoist','__meta__'][i]})),callTool:()=>{throw Error('Planning must not execute business tools')}};
 const result=await planAppWorldToolPermissions('A reading journal with note shelves',{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture-selector'},bridge);
 assert.deepEqual(result,[permissions[0],permissions[2]]);assert.equal(requests.length,1);assert.match(requests[0].messages[0].content,/Business Slot Agent/);assert.doesNotMatch(requests[0].messages[0].content,/Icon Designer/);
 response.services=[];const local=await planAppWorldServices('A purely local counter',{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture-selector'},bridge);assert.deepEqual(local.services,[]);assert.deepEqual(local.permissions,[permissions[2]]);
 response.services=['simple_note','todoist'];const multi=await planAppWorldServices('Notes with task tracking',{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture-selector'},bridge);assert.deepEqual(multi.services,['simple_note','todoist']);assert.deepEqual(multi.permissions,permissions);
 response.services=['unknown-service'];
 await assert.rejects(()=>planAppWorldToolPermissions('A reading journal',{apiKey:'fixture-only',apiBase:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture-selector'},bridge),/unknown service/);
});
