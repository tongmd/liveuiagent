import test from 'node:test';
import assert from 'node:assert/strict';
import {runAppWorldGrounding} from '../server/liveuiagent.js';
import {parseProjectionPolicy,projectionCoverageGaps} from '../server/grounding-view.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
const prior={entities:[{name:'First',id:'1'},{name:'Second',group:'Queue'},{name:'Third',id:'3'},{name:'Fourth',id:'4'}],stats:[{label:'Tracked',value:'4'}]};
const newRow={name:'New',id:'5'};
test('coverage is conservative, ID-first, strictly opt-in and does not authorize removal',()=>{
 assert.equal(parseProjectionPolicy(undefined),'unspecified');
 for(const policy of ['retain_existing','replace_or_filter','unspecified'] as const)assert.equal(parseProjectionPolicy(policy),policy);
 for(const invalid of [null,{},['retain_existing'],'RETAIN_EXISTING',' retain_existing ',true,42])assert.throws(()=>parseProjectionPolicy(invalid),/Model contract error/);
 assert.equal(projectionCoverageGaps('retain_existing',prior.entities,[newRow]).length,4);
 assert.equal(projectionCoverageGaps('retain_existing',prior.entities,[{name:'Renamed',id:'1'},{name:'Second',group:'Queue'},prior.entities[2],prior.entities[3]]).length,0);
 assert.equal(projectionCoverageGaps('retain_existing',[{name:'Second',group:'Queue'}],[{name:'Second',group:'Other'}]).length,0);
 for(const policy of ['replace_or_filter','unspecified'] as const)assert.deepEqual(projectionCoverageGaps(policy,prior.entities,[]),[]);
 assert.deepEqual(projectionCoverageGaps('retain_existing',[],[]),[]);
});
for(const mode of ['reject','repair','replace','unfinished'] as const)test(`actual grounding coverage loop ${mode}: complete prior context and no repeated writes`,async()=>{
 const prompts:any[]=[];const ops:string[]=[];let step=0,reviews=0;
 const tools=['create_unit','create_other','read_units'].map(api=>({id:api,apiName:api,permission:api,appName:'units',method:api==='read_units'?'GET':'POST',purpose:api}));
 const bridge:any={getCapabilities:async()=>tools,callTool:async(api:string,args:any)=>{ops.push(api);return{tool:tools.find(t=>t.id===api),request:args,response:api==='read_units'?{units:[...prior.entities,newRow]}:newRow,dbChanges:null};}};
 const output=await runAppWorldGrounding({bridge,permissions:tools.map(t=>t.permission),appName:'Units',payload:{request:'Add New to the existing tracked units'},priorProjection:prior,llm:{model:'fixture-only',chatCompletion:async(request:any)=>{
  const sys=request.messages[0].content;const input=JSON.parse(request.messages[1].content.split('\n')[0]);prompts.push({sys,input});assert.deepEqual(input.priorProjection,prior);
  if(sys.includes('You analyze a GUI'))return reply({objective:'Add new tracked unit',projectionPolicy:mode==='replace'?'replace_or_filter':'retain_existing',deliverables:['New unit']});
  if(sys.includes('You are the Write Verifier'))return reply({approved:true});
  if(sys.includes('You are an INDEPENDENT evaluator')){reviews++;return reply(mode==='unfinished'&&reviews===1?{pass:false,deficiencies:['Original requested second unit still needs its write']}:{pass:true,deficiencies:[]});}
  step++;
  if(step===1)return reply({calls:[{api:'create_unit',args:{name:'New'}}]});
  if(step===2)return reply({calls:[{api:'read_units',args:{}}]});
  if(step===3)return reply({done:true,summary:'Created New',entities:[newRow],stats:[{label:'Tracked',value:'1'}]});
  if(step===4)return reply({calls:[{api:mode==='unfinished'?'create_other':'create_unit',args:{name:'New'}}]}); // must be blocked BEFORE verifier/bridge
  if(step===5)return reply({calls:[{api:'read_units',args:{}}]});
  return reply({done:true,summary:'Full tracked list read back',entities:mode==='repair'||mode==='unfinished'?[...prior.entities,newRow]:[newRow],stats:[{label:'Tracked',value:mode==='repair'?'5':'1'}]});
 }}});
 assert.equal(ops.filter(x=>x==='create_unit').length,1,'a confirmed successful create must never be replayed during coverage repair');
 assert.ok(prompts.some(p=>p.sys.includes('Write Verifier')));assert.ok(prompts.some(p=>p.sys.includes('INDEPENDENT evaluator')));
 if(mode==='reject'){assert.equal(output?.evaluation?.pass,false);assert.match(output!.evaluation!.deficiencies.join('\n'),/projection_coverage/);assert.ok(output!.attempts.some(x=>x.api==='(projection-coverage)'));}
 else assert.equal(output?.evaluation?.pass,true);
 if(mode==='unfinished')assert.deepEqual(ops,['create_unit','read_units','create_other','read_units'],'coverage must not block unfinished original business writes while evaluator already fails');
 if(mode==='repair'){assert.deepEqual(output?.entities,[...prior.entities,newRow]);assert.deepEqual(ops,['create_unit','read_units','read_units']);}
 if(mode==='replace')assert.deepEqual(ops,['create_unit','read_units']);
 assert.equal(output?.calls.filter(c=>c.tool.apiName==='create_unit').length,1,'real write receipt remains in complete evidence');
});

for(const invalid of ['retain-all', null, 1, {}, ['retain_existing']])test(`invalid provided policy fails before execution: ${JSON.stringify(invalid)}`,async()=>{
 let dispatched=0;
 const tools=[{id:'read_units',apiName:'read_units',permission:'read_units',appName:'units',method:'GET',purpose:'Read units'}];
 await assert.rejects(runAppWorldGrounding({bridge:{getCapabilities:async()=>tools,callTool:async()=>{dispatched++;throw Error('Must not dispatch');}} as any,permissions:['read_units'],appName:'Units',payload:{request:'Add New'},priorProjection:prior,llm:{model:'fixture-only',chatCompletion:async()=>reply({objective:'Add New',projectionPolicy:invalid})}}),/Model contract error: projectionPolicy/);
 assert.equal(dispatched,0);
});

test('ID-less reading books can move shelves while duplicates consume evidence one to one',()=>{
 const books=[{name:'The Overstory',group:'To read'},{name:'Piranesi',group:'To read'},{name:'Klara and the Sun',group:'Currently reading'},{name:'Project Hail Mary',group:'Finished'}];
 const after=[books[0],books[1],{name:'Klara and the Sun',group:'Finished',detail:'quietly devastating'},books[3],{name:'Tomorrow, and Tomorrow, and Tomorrow',group:'To read'}];
 assert.deepEqual(projectionCoverageGaps('retain_existing',books,after),[]);
 assert.equal(projectionCoverageGaps('retain_existing',books,after.filter(b=>b.name!=='Piranesi')).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',books,[after[4]]).length,4);
 const duplicateIds=[{id:'same',name:'First'},{id:'same',name:'Second'}];
 assert.equal(projectionCoverageGaps('retain_existing',duplicateIds,[{id:'same',name:'First'}]).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',duplicateIds,duplicateIds).length,0);
 const duplicateNames=[{name:'Same',group:'A'},{name:'Same',group:'B'},{name:'Same',group:'B'}];
 assert.equal(projectionCoverageGaps('retain_existing',duplicateNames,[{name:'Same',group:'A'},{name:'Same',group:'B'}]).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',duplicateNames,[{name:'Same',group:'B'},{name:'Same',group:'B'},{name:'Same',group:'B'}]).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',[{id:'stable',name:'Same'},{name:'Same'}],[{id:'stable',name:'Same'}]).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',[{id:'stable',name:'Same'}],[{id:'other',name:'Same'}]).length,1);
 assert.equal(projectionCoverageGaps('retain_existing',[{name:'Old'}],[{name:'Renamed'}]).length,1,'ID-less rename remains unknown');
});

test('a shared source container cannot permit rekeying an independent payment record',()=>{
 const carriers=[{id:'shelf',name:'First'},{id:'shelf',name:'Second'}];
 const prior=[...carriers,{id:'payment-1',name:'Alice'}];
 for(const destination of [[{id:'new',name:'Alice'}],[{id:'new',name:'Alice'},{id:'new',name:'Other'}]]) {
  const gaps=projectionCoverageGaps('retain_existing',prior,[...carriers,...destination]);
  assert.equal(gaps.length,1);assert.match(gaps[0],/payment-1/);
 }
});
test('synthetic SQL-shaped book projections need unit IDs rather than changing container IDs',()=>{
 // These are synthetic COMPLETE projections of the actual note membership,
 // not the unretained model proposal from the closed run.
 const prior=[{id:'3085',name:'The Overstory',group:'To read'},{id:'3085',name:'Piranesi',group:'To read'},{id:'3085',name:'Tomorrow, and Tomorrow, and Tomorrow',group:'To read'},{id:'3086',name:'Klara and the Sun',group:'Currently reading'},{id:'3084',name:'Project Hail Mary',group:'Finished'}];
 const current=[...prior.slice(0,3),{id:'3084',name:'Klara and the Sun',group:'Finished'},prior[4]];
 for(const projection of [current,[...current].reverse()]) {
  const gaps=projectionCoverageGaps('retain_existing',prior,projection);
  assert.equal(gaps.length,1);assert.match(gaps[0],/Klara and the Sun/,'ambiguous provenance is not permission to change a record ID');
 }
 // A fresh view with no true book IDs omits IDs on both sides from the outset.
 // This does not migrate or repair the old saved projection automatically.
 const withoutId=(rows:typeof prior)=>rows.map(({id,...unit})=>unit);
 assert.deepEqual(projectionCoverageGaps('retain_existing',withoutId(prior),withoutId(current)),[]);
 assert.equal(projectionCoverageGaps('retain_existing',withoutId(prior),withoutId(current.filter(b=>b.name!=='Piranesi'))).length,1);
});
