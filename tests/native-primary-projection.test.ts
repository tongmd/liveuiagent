import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {parsePrimaryMembership,primaryProjectionDeficiencies,type PrimaryMembership} from '../server/native-primary-projection.js';
import {createAppStateAdapter,createInitialAppStateAdapter} from '../server/native-app-state.js';import {normalizeGroundingEntities} from '../server/grounding-entities.js';
import {groundingViewContext} from '../server/grounding-view.js';import {runAppWorldGrounding,applyVerifiedInitialContent,makeBusinessFields} from '../server/liveuiagent.js';
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});const fields=[{name:'member_name',type:'string'}];
const catalog=Array.from({length:20},(_,i)=>({name:'Public '+i,id:String(i+1)}));
const cap:any={id:'tool.appworld.directory.search',permission:'tool.appworld.directory.search',source:'appworld',appName:'directory',apiName:'search',method:'GET',path:'/directory/search',label:'Search public objects',purpose:'Search global discovery catalog, not saved membership',inputSchema:{type:'object'}};
async function flow(t:any,kind:PrimaryMembership,entities:any[],options:{seed?:boolean;stats?:any[];verdict?:boolean;prior?:any[];writeFirst?:boolean}={}){
 const db=new Database(':memory:');db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('fixture','alice');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('other','bob');t.after(()=>db.close());
 const full=createAppStateAdapter(db,'alice','fixture',fields,['storage.app','app_state.write'])!;
 if(options.seed)full.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'member-one',values:{member_name:'Chosen member'}});
 const adapter=options.writeFirst?full:createInitialAppStateAdapter(db,'alice','fixture',fields,['storage.app','app_state.write'])!;
 let decisions=0;let reads=0;const inputs:any[]=[];
 const bridge:any={getCapabilities:async()=>[cap],callTool:async(id:string,args:any)=>{assert.equal(id,cap.id);reads++;return{tool:cap,request:args,requestSource:'bridge-returned-request',response:catalog};}};
 const output=await runAppWorldGrounding({bridge,appState:adapter,permissions:[cap.permission],payload:{},appName:'Membership fixture',appPurpose:'The original need determines the declared primary collection.',viewContext:{itemLabel:'Member',primaryMembership:kind,perItemActions:[]},priorProjection:options.prior?{entities:options.prior,stats:[]}:undefined,llm:{model:'fixture',chatCompletion:async(request,call)=>{
  const label=call!.roleLabel;inputs.push({label,system:request.messages[0].content,user:JSON.parse(request.messages[1].content)});
  if(label==='Grounding Requirement Agent')return reply({objective:'Read current membership',projectionPolicy:'retain_existing',deliverables:[],expectedNumbers:[]});
  if(label==='Grounding Evaluator Agent')return reply({pass:options.verdict!==false,deficiencies:options.verdict===false?['Required external business result missing']:[]});
  if(label==='Write Verifier Agent')return reply({approved:true,calls:JSON.parse(request.messages[1].content).proposedCalls});
  assert.equal(label,'AppWorld Grounding Agent');decisions++;if(options.writeFirst&&[1,4,6].includes(decisions))return reply({calls:[{api:'app_state.upsert_record',args:{recordKind:'primary_member',recordId:'member-one',values:{member_name:'Chosen member'}}}]});if(options.writeFirst&&[2,5].includes(decisions))return reply({calls:[{api:'app_state.list_records',args:{recordKind:'primary_member',}},{api:cap.id,args:{}}]});if(!options.writeFirst&&decisions===1)return reply({calls:[{api:'app_state.list_records',args:{recordKind:'primary_member',}},{api:cap.id,args:{}}]});return reply({done:true,summary:'Current verified collection',entities,stats:options.stats??[]});
 }}});return{output,reads,inputs,db,adapter};
}
test('membership scalar strictly accepts only declared kinds, with no generated default',async()=>{
 for(const value of ['app_local','service_collection','discovery','none'])assert.equal(parsePrimaryMembership(value),value);
 for(const value of [undefined,null,'saved',{},false])assert.throws(()=>parsePrimaryMembership(value));
 assert.equal(groundingViewContext({manifest:{intent:{itemLabel:'Entry'}}})?.primaryMembership,undefined,'legacy absence is not reclassified');
 for(const kind of ['app_local','service_collection','discovery','none'])assert.equal(groundingViewContext({manifest:{intent:{itemLabel:'Entry',primaryMembership:kind}}})?.primaryMembership,kind);
 assert.throws(()=>groundingViewContext({manifest:{intent:{itemLabel:'Entry',primaryMembership:'guessed'}}}));
});
test('initial adapter lists genuine owner/app SQLite records without granting write or reading another scope',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');for(const[app,owner]of[['fixture','alice'],['other','alice'],['fixture','bob']])db.prepare('INSERT INTO agent_apps VALUES(?,?)').run(app,owner);
 for(const[app,owner]of[['fixture','alice'],['other','alice'],['fixture','bob']])createAppStateAdapter(db,owner,app,fields,['storage.app','app_state.write'])!.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'same',values:{member_name:owner+'/'+app}});
 const adapter=createInitialAppStateAdapter(db,'alice','fixture',fields,['storage.app','app_state.write'])!;assert.equal(adapter.capabilities.length,2);assert.deepEqual(adapter.listAll('primary_member').map(r=>r.values.member_name),['alice/fixture']);assert.throws(()=>adapter.call('app_state.upsert_record',{recordKind:'primary_member',recordId:'new',values:{member_name:'Fake'}}),/Unauthorized/);assert.equal(createInitialAppStateAdapter(db,'alice','fixture',fields,[]),undefined);
});
test('global catalog twenty is not app-local membership even when evaluator incorrectly says pass',async t=>{
 const{output}=await flow(t,'app_local',catalog);assert.equal(output?.evaluation?.pass,false);assert(output?.evaluation?.deficiencies.some(x=>x.startsWith('primary_membership:')));
});
test('actual empty local list may publish verified empty but catalog-derived saved stats cannot',async t=>{
 const good=await flow(t,'app_local',[],{stats:[{label:'Members',value:'0'}]});assert.equal(good.output?.evaluation?.pass,true);const stored:any={runtimeState:{entities:[{name:'Old'}],entityStats:[]}};assert.equal(applyVerifiedInitialContent(stored,good.output),true);assert.deepEqual(stored.runtimeState.entities,[]);
 const bad=await flow(t,'app_local',[],{stats:[{label:'Members',value:'20'}]});assert.equal(bad.output?.evaluation?.pass,false);
});
test('one actually-read member permits one saved row, not nineteen unrelated discoveries',async t=>{
 const member={name:'Chosen member',appRecordId:'member-one'};const good=await flow(t,'app_local',[member],{seed:true});assert.equal(good.output?.evaluation?.pass,true);
 const bad=await flow(t,'app_local',[member,...catalog.slice(0,19)],{seed:true});assert.equal(bad.output?.evaluation?.pass,false);
});
test('service-owned collections and explicit discovery are not forced into local membership',async t=>{
 for(const kind of ['service_collection','discovery']as const){const{output}=await flow(t,kind,catalog);assert.equal(output?.evaluation?.pass,true);assert.equal(output?.entities.length,20);}
});
test('local read association cannot waive the independent external business verdict',async t=>{
 const{output}=await flow(t,'app_local',[{name:'Chosen member',appRecordId:'member-one'}],{seed:true,verdict:false});assert.equal(output?.evaluation?.pass,false);
});
test('twenty-one raw rows stay complete for review and fail capacity even when evaluator approves',async t=>{
 const raw=[...catalog,{name:'New member',id:'21'}];const{output,inputs}=await flow(t,'service_collection',raw);assert.equal(output?.entities.length,21);assert.equal(output?.evaluation?.pass,false);assert(output?.evaluation?.deficiencies.some(x=>x.startsWith('projection_capacity:')));assert.equal(inputs.find(x=>x.label==='Grounding Evaluator Agent').user.visibleEntities.length,21);
 const stored:any={runtimeState:{entities:[{name:'Old persisted row'}],entityStats:[]}};assert.equal(applyVerifiedInitialContent(stored,output),false);assert.deepEqual(stored.runtimeState.entities,[{name:'Old persisted row'}]);assert.equal(normalizeGroundingEntities(raw,new Set(),[],[]).length,21);
});
test('none rejects invented primary rows; missing actual read cannot verify empty local membership',()=>{
 assert(primaryProjectionDeficiencies('none',[{name:'Unexpected'}],[],[]).length>0);assert(primaryProjectionDeficiencies('app_local',[],[],[]).length>0);
});
test('new BusinessSlot designs must declare membership independently of display noun',async()=>{
 const base={appName:'Collection',tagline:'Collect selected entries',accent:'#426b57',slots:[{label:'Entry name',type:'string',required:false}],actions:[{label:'Add entry',description:'Add selected entry'}],services:[],itemLabel:'Entry',glyph:'📚',tileTagline:'Chosen entries',metricLabel:'Entries',collection:'Entries',actionVerb:'Add'};
 for(const primaryMembership of [undefined,'app_local']){
  let calls=0;const run=()=>makeBusinessFields('Collect chosen entries','Entries',[],{focus:'Entries',resultFocus:'Entries'},{model:'fixture',chatCompletion:async()=>{calls++;return reply({...base,...(primaryMembership?{primaryMembership}:{})});}});if(primaryMembership){assert.equal((await run()).primaryMembership,'app_local');}else await assert.rejects(run(),/primaryMembership/);assert.equal(calls,1);
 }
});

test('capacity failure preserves one committed local write and blocks later writes even after more reads',async t=>{
 const raw=[...catalog,{name:'New member',id:'21'}];const{output,adapter}=await flow(t,'service_collection',raw,{writeFirst:true});assert.equal(output?.evaluation?.pass,false);assert.equal(adapter.listAll('primary_member')[0].revision,1);assert.equal(output?.appStateCalls.filter(x=>x.api==='app_state.upsert_record'&&x.ok===true).length,1);assert(output?.appStateCalls.some(x=>x.dispatchBlocked===true));
});
test('one membership cannot duplicate rows and a missing-record read cannot prove an empty collection',()=>{
 const response={source:'app-state',operation:'read',scope:'authenticated-current-owner-app',persisted:true,record:{recordId:'one',revision:1,values:{member_name:'Member'}}};const calls=[{source:'app-state',api:'app_state.read_record',request:{recordId:'one'},order:1,ok:true,executionState:'succeeded',requestSource:'host-bound-app-state-dispatched-arguments',response}];
 assert(primaryProjectionDeficiencies('app_local',[{name:'Member',appRecordId:'one'},{name:'Member',appRecordId:'one'}],calls,fields).some(x=>x.includes('multiple')));assert(primaryProjectionDeficiencies('app_local',[],calls,fields).some(x=>x.includes('empty first list')));
});

test('long local names use exact unshortened read evidence while display may be compact',()=>{
 const name='A deliberately long complete member identity that exceeds forty display characters';const row={name,appRecordId:'one'};const calls=[{source:'app-state',api:'app_state.read_record',request:{recordId:'one'},order:1,ok:true,executionState:'succeeded',requestSource:'host-bound-app-state-dispatched-arguments',response:{source:'app-state',operation:'read',scope:'authenticated-current-owner-app',persisted:true,record:{recordKind:'primary_member',recordId:'one',revision:1,values:{member_name:name}}}}];
 assert.deepEqual(primaryProjectionDeficiencies('app_local',[row],calls,fields),[]);assert.equal(normalizeGroundingEntities([row],new Set([name]),calls,fields).length,1);assert.equal(normalizeGroundingEntities([row],new Set([name]),[],fields).length,0);assert.equal(normalizeGroundingEntities([row],new Set([name]),calls,fields)[0].name.length,40);
});

test('all four actual grounding role requests share the required local record binding and unambiguous done schema',async t=>{
 const result=await flow(t,'app_local',[{name:'Chosen member',id:'external-service-one',appRecordId:'member-one'}],{writeFirst:true});assert.equal(result.output?.evaluation?.pass,true);
 const roles=['Grounding Requirement Agent','AppWorld Grounding Agent','Write Verifier Agent','Grounding Evaluator Agent'];for(const label of roles){const request=result.inputs.find(x=>x.label===label);assert.ok(request,`actual ${label} request observed`);assert.match(request.system,/EVERY primary entity row MUST include appRecordId/);assert.match(request.system,/generic id may be an external service identifier/);assert.match(request.system,/one complete nonempty declared persisted string field value verbatim/);assert.match(request.system,/never repeat a successful write merely to repair/);assert.doesNotMatch(request.system,/optional appRecordId/);}
 const executor=result.inputs.find(x=>x.label==='AppWorld Grounding Agent');assert.match(executor.system,/'?appRecordId"?:? /);assert.ok(executor.system.includes('REQUIRED only for app_local: exact actual separately-read record.recordId'));assert.ok(executor.system.includes('omit for other kinds'));
});
test('bare id never substitutes for explicit local binding even if actual record id happens to match',async t=>{
 const omitted=await flow(t,'app_local',[{name:'Chosen member',id:'member-one'}],{seed:true});assert.equal(omitted.output?.evaluation?.pass,false);assert(omitted.output?.evaluation?.deficiencies.some(x=>x.startsWith('primary_membership:')));
 const explicit=await flow(t,'app_local',[{name:'Chosen member',id:'external-id',appRecordId:'member-one'}],{seed:true});assert.equal(explicit.output?.evaluation?.pass,true,'explicit separately-read membership proof remains distinct from external id');
 const decorated=await flow(t,'app_local',[{name:'Chosen member (decorated status)',appRecordId:'member-one'}],{seed:true});assert.equal(decorated.output?.evaluation?.pass,false,'presentation text cannot silently become identity evidence');
});
