import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {makeBusinessFields,designAppSurface,createLiveUIRuntime} from '../server/liveuiagent.js';

const fields=[
 {name:'part_name',label:'Part name',type:'string',required:true},
 {name:'target_cost',label:'Target cost',type:'number',required:true},
 {name:'needed_date',label:'Needed date',type:'date',required:true},
 {name:'alert_enabled',label:'Alert enabled',type:'boolean',required:false},
 {name:'extra_details',label:'Extra details',type:'text',required:false},
] as any[];
const reply=(value:any)=>({choices:[{message:{content:JSON.stringify(value)}}]});
function components(names=['part_name','target_cost','needed_date'],row=false){
 const list:any[]=[{id:'overview',component:'Column',children:['hero','heading','list','result',...names.map(n=>'f_'+n),'go']},
 {id:'hero',component:'StatBlock',label:{path:'/draft/statLabel'},value:{path:'/draft/statValue'}},
 {id:'heading',component:'SectionHeading',title:'Repair parts'},
 {id:'list',component:'List',children:{componentId:'item',path:'/entities'}},
 {id:'item',component:'Card',child:'itemColumn'},
 {id:'itemColumn',component:'Column',children:['name','detail',...(row?['rowGo']:[])]},
 {id:'name',component:'Text',text:{path:'name'}},{id:'detail',component:'Text',text:{path:'detail'}},
 {id:'result',component:'Text',text:{path:'/draft/result'}},
 ...names.map(name=>({id:'f_'+name,component:'TextField',label:fields.find(f=>f.name===name).label,value:{path:'/draft/slots/'+name},variant:({number:'stepper',date:'date',boolean:'toggle',text:'longText'} as any)[fields.find(f=>f.name===name).type]||'shortText'})),
 {id:'go',component:'Button',child:'goText',action:{event:{name:'save.run'}}},{id:'goText',component:'Text',text:'Set target'}];
 if(row)list.push({id:'rowGo',component:'Button',child:'rowText',action:{event:{name:'remove.run'}}},{id:'rowText',component:'Text',text:'Remove part'});
 return list;
}
async function design(raw:any[],allFields=fields,perItem=false,requests:any[]=[]){
 return designAppSurface({name:'Parts',description:'Track each part and its target cost',sourcePrompt:'Save repair parts and set a separate target cost and needed date for each part.',businessFields:allFields,actions:[{actionId:'save.run',label:'Set target'},...(perItem?[{actionId:'remove.run',label:'Remove part',perItem:true}]:[])],llm:{model:'fixture-only',chatCompletion:async(request:any)=>{requests.push(request);return reply({components:requests.length===1?raw:components()});}}});
}

test('business planning prioritizes explicit per-object task inputs over optional settings without generic Request',async()=>{
 const requests:any[]=[];
 const result=await makeBusinessFields('Keep repair parts with a target cost and needed date for each part. Check costs when I ask.','Parts',['repair','parts'],{focus:'Parts',resultFocus:'Targets'},{model:'fixture-only',chatCompletion:async(request:any)=>{requests.push(request);return reply({appName:'Parts',tagline:'Track parts and target costs',accent:'#426b57',slots:fields,actions:[{label:'Set target',description:'Save a part and its target cost'},{label:'Check costs',description:'Compare actual costs with saved targets'},{label:'Remove part',description:'Remove the selected part',perItem:true}],services:[],itemLabel:'Part',glyph:'🔧',metric:'',metricLabel:'Parts',collection:'Parts',tileTagline:'Repair parts',actionVerb:'Open'});}});
 const contract=requests[0].messages[0].content;
 assert.match(contract,/core task inputs first/);assert.match(contract,/per-object value/);assert.match(contract,/Existing listed-row identity/);assert.match(contract,/optional preferences and settings must remain optional/);
 assert.deepEqual(result.slots.filter(f=>f.required).map(f=>f.name),['part_name','target_cost','needed_date']);
 assert.equal(result.slots.find(f=>f.name==='alert_enabled')?.required,false);
 assert.equal(result.slots.some(f=>/^request$/i.test(f.label)),false);
});

test('required business inputs cannot be omitted, substituted by text, disabled or reachable only in nonempty rows',async()=>{
 const badTrees:any[][]=[];
 badTrees.push(components(['part_name','needed_date','alert_enabled'])); // Still three controls: old count gate accepted this.
 const textOnly=components(['part_name','needed_date','alert_enabled']);textOnly.push({id:'targetLabel',component:'Text',text:'Target cost'});textOnly[0].children.push('targetLabel');badTrees.push(textOnly);
 for(const property of [{hidden:true},{visible:false},{disabled:true},{readOnly:true},{editable:false}]){const raw=components();Object.assign(raw.find(c=>c.id==='f_target_cost'),property);badTrees.push(raw);}
 const rowOnly=components();rowOnly[0].children=rowOnly[0].children.filter((id:string)=>id!=='f_target_cost');rowOnly.find(c=>c.id==='itemColumn').children.push('f_target_cost');badTrees.push(rowOnly);
 for(const raw of badTrees){const requests:any[]=[];const valid=await design(raw,fields,false,requests);assert.equal(requests.length,2,'invalid tree must enter bounded designer repair instead of shipping');const retry=JSON.parse(requests[1].messages[1].content);assert.match(retry.previousAttemptRejected,/required|visible and editable/);assert.match(retry.previousAttemptRejected,/target_cost/);assert.ok(valid.some(c=>c.id==='f_target_cost'&&c.component==='TextField'));const sent=JSON.parse(requests[0].messages[1].content);assert.equal(sent.slots.find((s:any)=>s.slot==='target_cost').required,true);assert.equal(sent.slots.find((s:any)=>s.slot==='alert_enabled').required,false);}
 const requests:any[]=[];await design(components(),fields,false,requests);assert.equal(requests.length,1,'optional settings may be omitted; no forced bloated form');
});

test('persisted Native surface exposes editable core bindings and uses row identity without a duplicate identity slot',async t=>{
 const selectedFields=fields.filter(f=>f.name!=='part_name');
 const tree=await design(components(['target_cost','needed_date','alert_enabled'],true),selectedFields,true);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-core-inputs-'));const db=new Database(':memory:');t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const old=process.env.APPWORLD_ENABLED;process.env.APPWORLD_ENABLED='false';let runtime:any;try{runtime=createLiveUIRuntime(db,{registryRoot:path.join(dir,'apps'),projectRoot:process.cwd()});}finally{if(old===undefined)delete process.env.APPWORLD_ENABLED;else process.env.APPWORLD_ENABLED=old;}
 const interaction={focus:'Parts',resultFocus:'Targets',primaryFieldName:'target_cost',secondaryFieldName:'needed_date',businessFields:selectedFields,historyTitle:'Parts',inputTitle:'Part targets',inputDescription:'Set a target cost and needed date'};
 const result={title:'Parts',value:'Parts',subtitle:'Saved parts',sections:[],bullets:[]};
 const pkg={manifest:{appId:'parts',name:'Parts',description:'Track repair parts',version:'1',intent:{visualObjects:['parts']}},actions:{actions:{'save.run':{id:'save.run',label:'Set target'},'remove.run':{id:'remove.run',label:'Remove part',perItem:true}}},dataSchema:{dataSources:{records:{model:'part'}},models:{part:{fields:[{name:'prompt',label:'Part'},{name:'context',label:'Details'}]}}},memory:{defaultState:{}},agents:{},proposal:{},orchestration:{},assets:{icon:{svg:'<svg xmlns="http://www.w3.org/2000/svg"/>',review:{}}},frontend:{generatedBy:'fixture',entry:'index.html',preview:'index.html',sourcePromptHash:'fixture',files:{'App.tsx':'export default ()=>null','preview.html':'<html>Fixture</html>'}},ui:{pages:[{id:'home',components:[{id:'root',type:'view',props:{accent:'#426b57'}}]}],meta:{designedOverview:tree}}};
 const state={sourcePrompt:'Set a target cost for each selected repair part',subject:'Parts',functionSignature:'parts_fixture',interaction,orchestration:{workflowId:'parts',routes:[]},intentResult:result,intentActionCount:0,recentActions:[],entities:[{id:'part-42',name:'Pump',detail:'Existing repair part'}],entityStats:[]};
 const data={records:[{id:'turn1',prompt:'Set target',context:'Existing parts',state:'open',nextStep:'Set target',result:'Saved parts',target_cost:'',needed_date:'',alert_enabled:''}]};
 db.prepare('INSERT INTO agent_apps(app_id,name,description,package_json,data_json,runtime_state_json,version,owner) VALUES(?,?,?,?,?,?,?,?)').run('parts','Parts','Track repair parts',JSON.stringify(pkg),JSON.stringify(data),JSON.stringify(state),'1','fixture-owner');
 const query=await runtime.queryState({user:'fixture-owner'});const app=query.apps[0];const surface=app.appPackage.ui.meta.a2ui;const nodes=surface.messages.flatMap((m:any)=>m.updateComponents?.components||[]);
 assert.deepEqual(nodes.filter((n:any)=>n.component==='TextField').map((n:any)=>n.value.path).sort(),['/draft/slots/alert_enabled','/draft/slots/needed_date','/draft/slots/target_cost']);
 const row=nodes.find((n:any)=>n.id==='d_rowGo');assert.equal(row.action.event.name,'actions.remove.run');assert.deepEqual(row.action.event.context,{entityName:{path:'/entityName'},entityId:{path:'/id'}});assert.equal(surface.initialData.entities[0].id,'part-42');
 const composer=nodes.find((n:any)=>n.id==='d_go');assert.deepEqual(composer.action.event.context.target_cost,{path:'/draft/slots/target_cost'});
 const reopened=await runtime.queryState({user:'fixture-owner'});assert.deepEqual(reopened.apps[0].appPackage.ui.meta.a2ui,surface);
 if(process.env.NATIVE_CORE_INPUT_FIXTURE_OUT)fs.writeFileSync(process.env.NATIVE_CORE_INPUT_FIXTURE_OUT,JSON.stringify(query));
 // New generation gates must not make previously persisted surfaces unreadable.
 pkg.ui.meta.designedOverview=components(['needed_date','alert_enabled','extra_details'],true);
 db.prepare('UPDATE agent_apps SET package_json=? WHERE app_id=?').run(JSON.stringify(pkg),'parts');
 const legacy=await runtime.queryState({user:'fixture-owner'});assert.equal(legacy.apps.length,1);assert.equal(legacy.apps[0].appPackage.ui.meta.a2ui.messages.flatMap((m:any)=>m.updateComponents?.components||[]).some((n:any)=>n.id==='d_f_target_cost'),false);
});
