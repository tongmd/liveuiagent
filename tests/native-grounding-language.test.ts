import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createAppStateAdapter} from '../server/native-app-state.js';
import {runAppWorldGrounding} from '../server/liveuiagent.js';

for(const command of [undefined,'请显示我保存的物品。']) test(`actual grounding packet presentation authority: ${command?'command':'original purpose'}`,async()=>{
 const db=new Database(':memory:');
 try {
 db.exec('CREATE TABLE agent_apps(app_id TEXT,owner TEXT)');db.prepare('INSERT INTO agent_apps VALUES(?,?)').run('one','alice');
 const adapter=createAppStateAdapter(db,'alice','one',[{name:'title',type:'string'}],['storage.app'])!;
 const original='Display my saved items in the language of this original request. '+ 'Preserve every original instruction. '.repeat(15);
 const tool={id:'tool.appworld.catalog.show_item',permission:'tool.appworld.catalog.show_item',appName:'catalog',apiName:'catalog.show_item',method:'GET',purpose:'Read an actual fixture item'};
 const bridge={getCapabilities:async()=>[tool],callTool:async()=>({tool,request:{item_id:0},response:{name:'原始专有名',status:'enum_original',item_id:0,message:'这是接口的中文说明'},ok:true})};
 let step=0;const seen:string[]=[];const reply=(x:unknown)=>({choices:[{message:{content:JSON.stringify(x)}}]});
 const result=await runAppWorldGrounding({bridge:bridge as any,appState:adapter,permissions:[tool.permission],appName:'中文应用名',appPurpose:original,currentUserCommand:command,payload:{title:'item'},fields:[{label:'物品名称',value:'item'}],actionLabel:'读取',priorProjection:{entities:[],stats:[{label:'以前的中文统计',value:'0'}]},llm:{model:'fixture-only',chatCompletion:async(request,options)=>{
 const role=options!.roleLabel;const packet=JSON.parse(request.messages[1].content);seen.push(role);
 if(role==='Grounding Requirement Agent'||role==='AppWorld Grounding Agent'){
 assert.deepEqual(packet.presentationLanguage,{source:command?'current_user_command':'original_app_purpose',text:command??original});
 assert.match(request.messages[0].content,/Synthetic action\/field labels, app names, previous summaries and API response language are NOT language authority/);
 assert.equal(packet.userRequest.includes('物品名称: item'),true);
 if(role==='AppWorld Grounding Agent'&&step>0){assert.equal(packet.previousCalls[0].response.message,'这是接口的中文说明');assert.equal(packet.previousCalls[0].response.item_id,0);assert.equal(packet.previousCalls[0].response.status,'enum_original');}
 }
 if(role==='Grounding Requirement Agent')return reply({objective:'Read saved items',deliverables:[],expectedNumbers:[]});
 if(role==='Grounding Evaluator Agent')return reply({pass:true,deficiencies:[]});
 assert.equal(role,'AppWorld Grounding Agent');return reply(step++===0?{calls:[{api:'catalog.show_item',args:{item_id:0}},{api:'app_state.list_records',args:{recordKind:'primary_member'}}]}:{done:true,summary:'No saved items',entities:[],stats:[{label:'Items',value:'0'}]});
 }}});
 assert.equal(result?.evaluation?.pass,true);assert.equal(seen.filter(x=>x==='AppWorld Grounding Agent').length,2);assert.equal(result?.calls.length,1);assert.equal(result?.appStateCalls.length,1);
 } finally {db.close();}
});
