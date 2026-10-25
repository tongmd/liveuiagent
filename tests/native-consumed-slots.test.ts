import {randomUUID} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import {consumedSlotsFromIndices,requireConsumedSlots,rowActionSlotMap,assertRowActionPayload} from '../server/native-action-slots.js';
import {makeBusinessFields,makeFunctions,validateDesignedOverview,designAppSurface} from '../server/liveuiagent.js';
const names=['new_time','alarm_label','amount','enabled'];
const fields=names.map(name=>({name,type:'string' as const,required:false}));
function design(){return {appName:'Entries',tagline:'Track selected entries',accent:'#336677',persistedDomainFields:[],slots:names.map(label=>({label:label.replaceAll('_',' '),type:'string',required:false})),actions:[{label:'Refresh',description:'Read current entries',perItem:false},{label:'Update',description:'Update selected entry',perItem:true,consumedSlotIndices:[0,1,2,3]},{label:'Done',description:'Mark selected entry complete',perItem:true,consumedSlotIndices:[]}],primaryMembership:'service_collection',services:[],itemLabel:'Entry',glyph:'📝',tileTagline:'Track entries',metricLabel:'Entries',collection:'Entries',actionVerb:'Refresh'};}
const normalize=(value:any)=>makeBusinessFields('Track entries','Entries',[],{focus:'Entries',resultFocus:'Saved'},{model:'fixture',chatCompletion:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});
function components(){return [
{id:'overview',component:'Column',children:['hero','heading',...names,'list','result','refresh']},
{id:'hero',component:'StatBlock',label:'Count',value:{path:'/draft/statValue'}},{id:'heading',component:'SectionHeading',title:'Entries'},
...names.map(name=>({id:name,component:'TextField',label:name.replaceAll('_',' '),variant:'shortText',value:{path:`/draft/slots/${name}`}})),
{id:'list',component:'List',children:{componentId:'row',path:'/entities'}},{id:'row',component:'Column',children:['title','detail','edit','done']},{id:'title',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}},
{id:'edit',component:'Button',child:'editLabel',action:{event:{name:'actions.edit',context:Object.fromEntries(names.map(name=>[name,{path:`/draft/slots/${name}`}]))}}},{id:'editLabel',component:'Text',text:'Update'},
{id:'done',component:'Button',child:'doneLabel',action:{event:{name:'actions.done',context:{}}}},{id:'doneLabel',component:'Text',text:'Mark done'},
{id:'result',component:'Text',text:{path:'/draft/result'}},{id:'refresh',component:'Button',child:'refreshLabel',action:{event:{name:'actions.refresh'}}},{id:'refreshLabel',component:'Text',text:'Refresh'}
] as any[];}
const opts={slots:fields,actionIds:['actions.refresh','actions.edit','actions.done'],rowActionSlots:{edit:names,done:[]},requireWidgets:true};
function surface(){const nodes=validateDesignedOverview(components(),opts);assert.ok(nodes);return {messages:[{updateComponents:{components:nodes}}]};}
test('raw indices map once to normalized names, preserve optional status and original 3 numbered functions',async()=>{
 const result=await normalize(design());assert.equal(result.actions.length,3);assert.deepEqual(result.actions[1].consumedSlots,result.slots.map(s=>s.name));assert.ok(result.slots.every(s=>s.required===false));assert.deepEqual(result.actions[2].consumedSlots,[]);
 const functions=makeFunctions(result.actions.map(a=>({...a,verb:a.label,target:'Entry'})),'fixed');assert.deepEqual(functions.map(f=>f.id),['agent_turn_1','agent_turn_2','agent_turn_3']);assert.deepEqual(functions[1].consumedSlots,result.slots.map(s=>s.name));
 for(const raw of [undefined,[0,0],[-1],[4],[1.2],['1']]){const d=design();(d.actions[1] as any).consumedSlotIndices=raw;await assert.rejects(normalize(d),/consumedSlotIndices/);}
 const collision=design();collision.slots[1].label=collision.slots[0].label;await assert.rejects(normalize(collision),/names collide/);
 const tooMany=design();tooMany.actions[0]={...tooMany.actions[2],label:'Archive'};tooMany.actions.push({...tooMany.actions[2],label:'Remove'});await assert.rejects(normalize(tooMany),/At most three/);
 const numbered=design();numbered.slots=numbered.slots.slice(0,3).map((field,i)=>({...field,label:['起床时间','闹钟名字','周几'][i]}));numbered.actions[1].consumedSlotIndices=[2,0];const numberedResult=await normalize(numbered);assert.deepEqual(numberedResult.slots.map(field=>field.name),['slot_1','slot_2','slot_3']);assert.deepEqual(numberedResult.actions[1].consumedSlots,['slot_3','slot_1']);
 assert.throws(()=>requireConsumedSlots(undefined),/explicit array/);assert.throws(()=>consumedSlotsFromIndices([] ,['same','same']),/collide/);
 assert.deepEqual(rowActionSlotMap([{actionId:'actions.edit',perItem:true,consumedSlots:names},{actionId:'actions.done',perItem:true,consumedSlots:[]}],names),{edit:names,done:[]});
});
test('designer requires exact per-action optional bindings and both row entries, forbids stale fields and targetless duplicates',()=>{
 assert.ok(validateDesignedOverview(components(),opts));
 for(const mode of ['missing','extra','missingButton','topLevel'] as const){const nodes=components();const edit=nodes.find(n=>n.id==='edit');if(mode==='missing')delete edit.action.event.context.alarm_label;if(mode==='extra')nodes.find(n=>n.id==='done').action.event.context.amount={path:'/draft/slots/amount'};if(mode==='missingButton')nodes.find(n=>n.id==='row').children=['title','detail','edit'];if(mode==='topLevel'){nodes[0].children.push('done');nodes.find(n=>n.id==='row').children=['title','detail','edit'];}assert.equal(validateDesignedOverview(nodes,opts),null,mode);}
});
test('host accepts exact optional scalar values on current owner/app row and rejects missing/extra/source/target before dispatch',()=>{
 const ui=surface();const action={perItem:true,consumedSlots:names};const targets=[{entityName:'First',entityId:'one',appRecordId:''},{entityName:'Second',entityId:'two',appRecordId:''}];const payload={entityName:'Second',entityId:'two',appRecordId:'',sourceComponentId:'d_edit',new_time:'05:45',alarm_label:'Gym',amount:0,enabled:false};
 assert.doesNotThrow(()=>assertRowActionPayload(action,payload,names,targets,ui,'edit'));assert.equal(payload.amount,0);assert.equal(payload.enabled,false);
 for(const value of [{...payload,alarm_label:undefined},Object.fromEntries(Object.entries(payload).filter(([k])=>k!=='alarm_label')),{...payload,stale:'old'},{...payload,entityId:'other-app',appRecordId:''},{...payload,sourceComponentId:'d_done'},{...payload,sourceComponentId:'d_refresh'},{...payload,amount:{value:0}}])assert.throws(()=>assertRowActionPayload(action,value,names,targets,ui,'edit'));
 assert.throws(()=>assertRowActionPayload(action,payload,names,[],ui,'edit'),/owner\/app/);
 const done={entityName:'First',entityId:'one',appRecordId:'',sourceComponentId:'d_done'};assert.doesNotThrow(()=>assertRowActionPayload({perItem:true,consumedSlots:[]},done,names,targets,ui,'done'));assert.throws(()=>assertRowActionPayload({perItem:true,consumedSlots:[]},{...done,amount:99},names,targets,ui,'done'));
 for(const slots of [undefined,['constructor'],['new_time','new_time'],['unknown']])assert.throws(()=>assertRowActionPayload({perItem:true,consumedSlots:slots},payload,names,targets,ui,'edit'));
});
test('real runtime owner/app route rejects forged row payload before model, tool authorization or local write',async()=>{
 const {default:Database}=await import('better-sqlite3');const {createLiveUIRuntime}=await import('../server/liveuiagent.js');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'row-contract-'));const db=new Database(':memory:');const old=process.env.APPWORLD_ENABLED;let runtime:any;
 try{process.env.APPWORLD_ENABLED='false';runtime=createLiveUIRuntime(db,{projectRoot:process.cwd(),registryRoot:path.join(dir,'apps')});}finally{if(old===undefined)delete process.env.APPWORLD_ENABLED;else process.env.APPWORLD_ENABLED=old;}
 try{
 const pkg={actions:{actions:{edit:{perItem:true,consumedSlots:names}}},ui:{meta:{a2ui:surface()}}};const state={interaction:{businessFields:fields},entities:[{name:'Second',id:'two'}]};
 db.prepare('INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('rows','Rows','Update rows',JSON.stringify(pkg),'{}',JSON.stringify(state),'1','alice');
 let modelCalls=0;const llm={model:'fixture',chatCompletion:async()=>{modelCalls++;throw Error('must not reach model');}};
 const payload={entityName:'Second',entityId:'two',appRecordId:'',sourceComponentId:'d_edit',new_time:'05:45',alarm_label:'Gym',amount:0,enabled:false};
 for(const bad of [{...payload,extra:'stale'},{...payload,sourceComponentId:'d_done'},{...payload,entityId:'one',appRecordId:''},Object.fromEntries(Object.entries(payload).filter(([k])=>k!=='alarm_label'))])await assert.rejects(runtime.action({requestId:randomUUID(),user:'alice',appId:'rows',actionId:'edit',eventPayload:bad,llm}),/Row action|Row target/);
 await assert.rejects(runtime.action({requestId:randomUUID(),user:'bob',appId:'rows',actionId:'edit',eventPayload:payload,llm}),/app not found/);assert.equal(modelCalls,0);
 assert.deepEqual(JSON.parse((db.prepare('SELECT runtime_state_json AS state FROM agent_apps').get()as any).state),state,'rejected direct calls do not alter persisted projection');
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('designer rejects a missing action contract before any model call; identity-only surfaces cannot gain a targetless composer',async()=>{
 let calls=0;await assert.rejects(designAppSurface({name:'Entries',description:'Edit entries',sourcePrompt:'Edit an entry',businessFields:fields,actions:[{actionId:'actions.edit',label:'Update',perItem:true}],llm:{model:'fixture',chatCompletion:async()=>{calls++;throw Error('unreachable');}}}),/explicit array/);assert.equal(calls,0);
 const nodes=components().filter(node=>!['refresh','refreshLabel'].includes(node.id));nodes[0].children=nodes[0].children.filter((id:string)=>id!=='refresh');assert.ok(validateDesignedOverview(nodes,{...opts,actionIds:['actions.edit','actions.done']}),'legitimate only-perItem app has exact row entries and no invented global action');
});

test('explicit maintained-list lifecycle supports Add plus three exact row actions without expanding the four-action budget',async()=>{
 const need='Maintain my equipment list: add entries, edit their label, remove an entry from this local list, and run the explicitly authorized service operation on one selected entry.';
 const d=design();d.actions=[{label:'Add',description:'Add a local entry',perItem:false},{label:'Update',description:'Edit one entry',perItem:true,consumedSlotIndices:[0,1,2,3]},{label:'Remove',description:'Remove one local entry',perItem:true,consumedSlotIndices:[]},{label:'Service',description:'Run the requested item operation',perItem:true,consumedSlotIndices:[]}];
 const result=await makeBusinessFields(need,'Entries',[],{focus:'Entries',resultFocus:'Saved'},{model:'fixture',chatCompletion:async()=>({choices:[{message:{content:JSON.stringify(d)}}]})});
 assert.equal(result.actions.length,4);assert.equal(result.actions.filter(a=>a.perItem).length,3);
 const functions=makeFunctions(result.actions.map(a=>({...a,verb:a.label,target:'Entry'})),'lifecycle');assert.equal(functions.length,4);
 assert.deepEqual(rowActionSlotMap([{actionId:'actions.edit',perItem:true,consumedSlots:names},{actionId:'actions.done',perItem:true,consumedSlots:[]},{actionId:'actions.service',perItem:true,consumedSlots:[]}],names),{edit:names,done:[],service:[]});
 const nodes=components();nodes.find(n=>n.id==='row').children.push('service');nodes.push({id:'service',component:'Button',child:'serviceLabel',action:{event:{name:'actions.service',context:{}}}},{id:'serviceLabel',component:'Text',text:'Service'});
 const contract={...opts,actionIds:[...opts.actionIds,'actions.service'],rowActionSlots:{...opts.rowActionSlots,service:[]}};
 assert.ok(validateDesignedOverview(nodes,contract));
 const pkg={messages:[{updateComponents:{components:validateDesignedOverview(nodes,contract)}}]};
 const payload={entityName:'One',entityId:'one',appRecordId:'',sourceComponentId:'d_service'};
 assert.doesNotThrow(()=>assertRowActionPayload({perItem:true,consumedSlots:[]},payload,names,[{entityName:'One',entityId:'one',appRecordId:''}],pkg,'service'));
 assert.throws(()=>assertRowActionPayload({perItem:true,consumedSlots:[]},{...payload,entityId:'other',appRecordId:''},names,[{entityName:'One',entityId:'one',appRecordId:''}],pkg,'service'),/owner\/app/);
 const duplicate=structuredClone(nodes);duplicate.find(n=>n.id==='service').action.event.name='actions.done';assert.equal(validateDesignedOverview(duplicate,contract),null);
 const fourth=[...result.actions.map(a=>({...a,verb:a.label,target:'Entry'}))];fourth[0]={...fourth[1],label:'Fourth'};assert.throws(()=>makeFunctions(fourth,'too-many-rows'),/At most three/);
 assert.throws(()=>makeFunctions([...functions.map(f=>({verb:'Act',target:'Entry',label:f.label,description:'Act'})),{verb:'Act',target:'Entry',label:'Fifth',description:'Act'}],'five'),/1-4/);
 assert.throws(()=>rowActionSlotMap(['a','b','c','d'].map(id=>({actionId:`actions.${id}`,perItem:true,consumedSlots:[]})),names),/At most three/);
 assert.equal(validateDesignedOverview(nodes,{...contract,rowActionSlots:{...contract.rowActionSlots,fourth:[]}}),null);
});
