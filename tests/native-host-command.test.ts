import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendHostCommand,businessSurfaceWithoutHostCommand,hostCommandDescriptor,parseHostCommandEvent} from '../server/native-host-command.js';
const fixture=()=>{const initialData={draft:{slots:{title:''}},entities:[]};return {messages:[{updateComponents:{components:[{id:'root',component:'Card',child:'root-column'},{id:'root-column',component:'Column',children:['dedicated']},{id:'dedicated',component:'TextField',label:'Title',value:{path:'/draft/slots/title'}}]}},{updateDataModel:{value:structuredClone(initialData)}}],initialData,actionMap:{'actions.add.run':{actionId:'actions.add.run',payloadSource:'event.context'}}};};
test('host block preserves every original dedicated component/state/action via strict round trip',()=>{
 const original=fixture(),actions={add:{permissions:['tool.appworld.notes'],payloadFields:['title']}};const before=structuredClone(actions);
 const result=appendHostCommand(original,actions);
 assert.deepEqual(businessSurfaceWithoutHostCommand(result.surface,result.descriptor),original);
 assert.deepEqual(actions,before);assert.deepEqual(original,fixture());
 assert.equal(result.surface.messages[0].updateComponents.components.filter((n:any)=>n.id==='dedicated').length,1);
 assert.equal(result.surface.initialData.hostCommand.draft,'');
});
test('host descriptor/block/root/state cannot be forged to exclude arbitrary model controls',()=>{
 for(const mutate of [(x:any)=>x.descriptor.actionId='actions.add.run',(x:any)=>x.surface.messages[0].updateComponents.components.at(-1).action.event.context.permissions=['all'],(x:any)=>x.surface.messages[0].updateComponents.components[1].children.pop(),(x:any)=>x.surface.initialData.hostCommand.permissions='all',(x:any)=>x.surface.actionMap['host.app.command'].payloadSource='hidden']){
  const x=appendHostCommand(fixture(),{});mutate(x);assert.throws(()=>businessSurfaceWithoutHostCommand(x.surface,x.descriptor),/host_command_contract/);
 }
});
test('model reserved components/actions/paths are rejected, not adopted',()=>{
 for(const value of [{action:'host.app.command'},{id:'host_app_command_input'},{value:{path:'/hostCommand/draft'}},{hostCommand:{draft:'injected'}}]){
  assert.throws(()=>appendHostCommand({...fixture(),extra:value},{}),/reserved/);
  assert.throws(()=>appendHostCommand(fixture(),value),/reserved/);
 }
});
test('payload is exact visible text only, source and transport nonce required',()=>{
 const event={command:'  Move the selected record\nonly after checking its identity.  ',requestId:'00000000-0000-4000-8000-000000000001',sourceComponentId:hostCommandDescriptor().buttonId};
 assert.deepEqual(parseHostCommandEvent(event),event);
 for(const bad of [{...event,command:''},{...event,command:'  '},{...event,command:'界'.repeat(3000)},{...event,requestId:'reuse-anything'},{...event,sourceComponentId:'dedicated'},{...event,permissions:['all']},{...event,title:'stale form'}])assert.throws(()=>parseHostCommandEvent(bad),/host_command_contract/);
});
