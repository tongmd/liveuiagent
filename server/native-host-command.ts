/** Host-only candidate protocol. Not installed into generated packages yet. */
export const HOST_COMMAND_ACTION = 'host.app.command';
const PREFIX = 'host_app_command_';
export const HOST_COMMAND_MAX_BYTES = 8192;
export type HostCommandDescriptor = {
  schemaVersion: 1; actionId: typeof HOST_COMMAND_ACTION;
  containerId: 'host_app_command_container'; inputId: 'host_app_command_input';
  buttonId: 'host_app_command_execute'; inputPath: '/hostCommand/draft';
};
export const hostCommandDescriptor = (): HostCommandDescriptor => ({schemaVersion:1,actionId:HOST_COMMAND_ACTION,
  containerId:'host_app_command_container',inputId:'host_app_command_input',buttonId:'host_app_command_execute',inputPath:'/hostCommand/draft'});
const fail = (reason: string): never => {throw new Error(`host_command_contract: ${reason}`);};
function object(value: unknown): Record<string, any> {
  if(!value || typeof value!=='object' || Array.isArray(value))return fail('object required');
  return value as Record<string,any>;
}
function exact(value: unknown, keys: string[]): Record<string,any> {
  const item=object(value);
  if(Object.keys(item).length!==keys.length || keys.some(key=>!Object.hasOwn(item,key)))return fail('unexpected or missing keys');
  return item;
}
function equal(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>;
  return Array.isArray(a)===Array.isArray(b)&&Object.keys(aa).length===Object.keys(bb).length&&Object.keys(aa).every(key=>Object.hasOwn(bb,key)&&equal(aa[key],bb[key]));
}
export function assertHostCommandDescriptor(raw:unknown):asserts raw is HostCommandDescriptor {
  if(!equal(raw,hostCommandDescriptor()))fail('descriptor must be exactly host-authored');
}
export function hostCommandComponents(): Record<string,any>[] {
 const d=hostCommandDescriptor();
 return [
  {id:d.containerId,component:'Column',children:[d.inputId,d.buttonId],align:'stretch'},
  {id:d.inputId,component:'TextField',label:'Ask this app',value:{path:d.inputPath},variant:'longText'},
  {id:PREFIX+'execute_label',component:'Text',text:'Execute'},
  {id:d.buttonId,component:'Button',child:PREFIX+'execute_label',action:{event:{name:d.actionId,context:{command:{path:d.inputPath}}}}},
 ];
}
function assertNoReserved(value:unknown):void {
 if(typeof value==='string') {
  if(value===HOST_COMMAND_ACTION || value.startsWith(PREFIX) || value==='/hostCommand' || value.startsWith('/hostCommand/'))fail('reserved namespace collision');
 } else if(value&&typeof value==='object') {
  for(const [key,child] of Object.entries(value)){
   if(key==='hostCommand'||key===HOST_COMMAND_ACTION||key.startsWith(PREFIX))fail('reserved namespace collision');
   assertNoReserved(child);
  }
 }
}
/** Append host controls to the known root column after model validation. Does not
 * alter business actions, slots or permissions and never accepts model host metadata. */
export function appendHostCommand(surfaceInput:unknown, businessActions:unknown):{surface:Record<string,any>;descriptor:HostCommandDescriptor} {
 assertNoReserved(surfaceInput);assertNoReserved(businessActions);
 const surface=structuredClone(object(surfaceInput));
 const updates=object(surface).messages;
 if(!Array.isArray(updates))return fail('messages required');
 const groups=updates.filter((message:any)=>message?.updateComponents);
 if(groups.length!==1)return fail('one component update required');
 const components=groups[0].updateComponents.components;
 if(!Array.isArray(components))return fail('components required');
 const ids=components.map((node:any)=>node.id);
 if(new Set(ids).size!==ids.length)return fail('duplicate component id');
 const root=components.find((node:any)=>node.id==='root');
 const column=components.find((node:any)=>node.id===root?.child);
 if(root?.component!=='Card'||column?.component!=='Column'||!Array.isArray(column.children))return fail('known root card/column required');
 column.children.push(hostCommandDescriptor().containerId);
 components.push(...hostCommandComponents());
 const data=object(surface.initialData);surface.initialData={...data,hostCommand:{draft:''}};
 for(const message of updates)if(message?.updateDataModel){
  if(!equal(message.updateDataModel.value,data))return fail('surface/data-model mismatch');
  message.updateDataModel.value=structuredClone(surface.initialData);
 }
 const actionMap=object(surface.actionMap);surface.actionMap={...actionMap,[HOST_COMMAND_ACTION]:{actionId:HOST_COMMAND_ACTION,payloadSource:'event.context'}};
 return {surface,descriptor:hostCommandDescriptor()};
}
/** Return the untouched business portion for existing strict model validators.
 * Exclusion is allowed only after exact block/metadata/root/state validation. */
export function businessSurfaceWithoutHostCommand(surfaceInput:unknown,rawDescriptor:unknown):Record<string,any> {
 assertHostCommandDescriptor(rawDescriptor);
 const surface=structuredClone(object(surfaceInput)),d=hostCommandDescriptor();
 const groups=surface.messages?.filter((message:any)=>message?.updateComponents);
 if(groups?.length!==1||!Array.isArray(groups[0].updateComponents.components))return fail('one component update required');
 const components=groups[0].updateComponents.components as Record<string,any>[];
 const host=components.filter(node=>String(node.id).startsWith(PREFIX));
 if(!equal(host,hostCommandComponents()))return fail('host block modified');
 const root=components.find(node=>node.id==='root'),column=components.find(node=>node.id===root?.child);
 if(root?.component!=='Card'||column?.component!=='Column'||!Array.isArray(column.children)||column.children.at(-1)!==d.containerId||column.children.filter((id:any)=>id===d.containerId).length!==1)return fail('host block must be root reachable');
 column.children.pop();
 groups[0].updateComponents.components=components.filter(node=>!String(node.id).startsWith(PREFIX));
 const state=exact(surface.initialData.hostCommand,['draft']);if(typeof state.draft!=='string')return fail('draft must be text');
 delete surface.initialData.hostCommand;
 for(const message of surface.messages)if(message?.updateDataModel){
  if(!equal(message.updateDataModel.value,{...surface.initialData,hostCommand:state}))return fail('surface/data-model mismatch');
  delete message.updateDataModel.value.hostCommand;
 }
 if(!equal(surface.actionMap?.[HOST_COMMAND_ACTION],{actionId:HOST_COMMAND_ACTION,payloadSource:'event.context'}))return fail('host action map modified');
 delete surface.actionMap[HOST_COMMAND_ACTION];
 assertNoReserved(surface);
 return surface;
}
/** requestId is transport-owned, not a model/context binding. User text is kept
 * byte-for-byte; trimming only determines emptiness. No implicit form fallback. */
export function parseHostCommandEvent(raw:unknown):{command:string;requestId:string;sourceComponentId:string} {
 const event=exact(raw,['command','requestId','sourceComponentId']);
 if(typeof event.command!=='string'||!event.command.trim()||Buffer.byteLength(event.command,'utf8')>HOST_COMMAND_MAX_BYTES)fail('nonempty bounded command required');
 if(event.sourceComponentId!==hostCommandDescriptor().buttonId)fail('invalid source component');
 if(typeof event.requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.requestId))fail('transport request id required');
 return {command:event.command,requestId:event.requestId,sourceComponentId:event.sourceComponentId};
}
