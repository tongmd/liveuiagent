import {createHash} from 'node:crypto';
import type {AppWorldToolCapability,AppWorldCallResult} from './appworld-bridge.js';
import type {AppStateCapability} from './native-app-state.js';
import {authorizedGroundingCapabilities} from './native-action-context.js';
import {validateApiValue} from './appworld-schema.js';
import {projectBusinessEvidence} from './grounding-evidence.js';

export type ProgressIntent={source:'host-current-command';message:string}|{source:'host-bound-current-row-action';actionId:string;targetEntity:{id:string;name:string;appRecordId?:string};eventPayloadSha256:string}|{source:'host-readonly-observation';phase:'initial_open'|'reopen'};
export type Scope={owner:string;appId:string;actionId:string;executionId:string;intent:ProgressIntent};
type Argument={literal:unknown}|{fromEffect:string;responsePointer:string}|{fromCurrentTarget:'id'|'appRecordId'}|{unresolvedFromEffect:string};
export type DeferredBindingProposal={bindingId:string;receiptOrder:number;responsePointer:string};
type BoundValue=DeferredBindingProposal&{value:unknown};
export type GuardedCall={api:string;args:Record<string,unknown>};
export type ProgressHostHooks={registerReadPreflightConsumer?:(consume:(scope:Scope,call:GuardedCall)=>string[])=>void;registerMutationVerifiedConsumer?:(consume:(scope:Scope,call:GuardedCall)=>string[])=>void};
export type RequiredEffect={id:string;api:string;effect:'external_read'|'external_write'|'local_read'|'local_write';requestQuote?:string;rowActionReference?:{actionId:string;targetEntityId:string};observationReference?:'initial_open'|'reopen';arguments:Record<string,Argument>;after?:string;when?:{effect:string;responsePointer:string;equals:unknown}};
type Capability=AppWorldToolCapability|AppStateCapability;
type Receipt={api:string;order:number;request:unknown;response:unknown;outcome:'succeeded'|'not_started'|'unknown';source:'appworld'|'app-state'};
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const wire=(v:unknown)=>JSON.stringify(canonical(v));
const sha=(v:unknown)=>createHash('sha256').update(wire(v)).digest('hex');
const plain=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const pointer=(v:unknown)=>typeof v==='string'&&/^\/(?:[^~]|~[01])*$/.test(v);
function objectKeys(value:unknown,required:string[],optional:string[]=[]):value is Record<string,any>{return Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));}
const read=(c:Capability)=>c.method==='GET'||c.method==='HEAD'||c.method==='OPTIONS';
function at(value:any,pointer:string):unknown{
 if(!/^\/(?:[^~]|~[01])*$/.test(pointer))throw Error('Invalid exact response pointer');
 for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))throw Error('Unresolved response pointer');value=value[part];}
 if(value===undefined||value===null||typeof value==='object')throw Error('Target reference must resolve to one actual scalar, not a collection or guessed choice');
 return value;
}
/** Internal, unwired progress hint. It grants no dispatch, authorization, completion,
 * or semantic-verification authority. Only the real dispatcher may record receipts;
 * never hydrate this object or its private history from a model/client packet. */
export class NativeOperationProgress{
 private readonly effects:RequiredEffect[];private readonly capabilities:Map<string,Capability>;private readonly receipts:Receipt[]=[];private readonly binding:string;private readonly bindingSlots=new Map<string,{effectId:string;argument:string;sourceEffect:string}>();private readonly pendingBindings=new Map<string,BoundValue>();private readonly boundValues=new Map<string,BoundValue>();
 readonly contractSha256:string;
 constructor(private readonly scope:Scope,effects:RequiredEffect[],external:AppWorldToolCapability[],permissions:readonly string[],local:AppStateCapability[]=[],hostHooks:ProgressHostHooks={}){
  if([scope.owner,scope.appId,scope.actionId,scope.executionId].some(v=>typeof v!=='string'||!v.trim()))throw Error('Exact current-turn scope required');
  const intent=scope.intent;
  if(!intent||intent.source==='host-current-command'&&!intent.message.trim()||intent.source==='host-bound-current-row-action'&&(intent.actionId!==scope.actionId||!intent.targetEntity.id||!intent.targetEntity.name||!(/^[a-f0-9]{64}$/).test(intent.eventPayloadSha256))||intent.source==='host-readonly-observation'&&!['initial_open','reopen'].includes(intent.phase)||!['host-current-command','host-bound-current-row-action','host-readonly-observation'].includes(intent.source))throw Error('Trusted current event source required');
  this.scope=plain(scope);this.binding=sha(scope);
  // Local capabilities must be obtained from the permission-filtered actual adapter.
  const caps:Capability[]=[...authorizedGroundingCapabilities(external,permissions),...local.filter(c=>c.source==='app-state'&&permissions.includes('storage.app')&&(read(c)||permissions.includes('app_state.write')))];
  this.capabilities=new Map(caps.map(c=>[c.apiName,plain(c)]));if(this.capabilities.size!==caps.length)throw Error('Ambiguous actual capability');
  if(!Array.isArray(effects)||Buffer.byteLength(JSON.stringify(effects),'utf8')>2*1024*1024)throw Error('Effects require a finite JSON array within the existing Native input byte limit');
  this.effects=plain(effects);const seen=new Set<string>();
  for(const e of this.effects){
   if(!objectKeys(e,['id','api','effect','arguments'],['requestQuote','rowActionReference','observationReference','after','when'])||typeof e.id!=='string'||!e.id.trim()||seen.has(e.id)||typeof e.api!=='string'||!e.arguments||typeof e.arguments!=='object'||Array.isArray(e.arguments))throw Error('Invalid effect contract');
   if(e.when!==undefined&&(!objectKeys(e.when,['effect','responsePointer','equals'])||typeof e.when.effect!=='string'||!e.when.effect.trim()||!pointer(e.when.responsePointer)||e.when.equals!==null&&!['string','number','boolean'].includes(typeof e.when.equals)))throw Error('Invalid prerequisite condition');
   if(e.rowActionReference!==undefined&&(!objectKeys(e.rowActionReference,['actionId','targetEntityId'])||typeof e.rowActionReference.actionId!=='string'||!e.rowActionReference.actionId.trim()||typeof e.rowActionReference.targetEntityId!=='string'||!e.rowActionReference.targetEntityId.trim()))throw Error('Invalid current row reference');
   const refs=Number(e.requestQuote!==undefined)+Number(e.rowActionReference!==undefined)+Number(e.observationReference!==undefined);
   if(refs!==1)throw Error('Exactly one current intent reference required');
   if(e.requestQuote!==undefined&&(intent.source!=='host-current-command'||typeof e.requestQuote!=='string'||!e.requestQuote.trim()||!intent.message.includes(e.requestQuote)))throw Error('Effect needs an exact current-message reference; app purpose is not action authorization');
   if(e.rowActionReference!==undefined&&(intent.source!=='host-bound-current-row-action'||e.rowActionReference.actionId!==intent.actionId||e.rowActionReference.targetEntityId!==intent.targetEntity.id))throw Error('Effect row action is not the actual current target');
   if(e.observationReference!==undefined&&(typeof e.observationReference!=='string'||!['initial_open','reopen'].includes(e.observationReference)||intent.source!=='host-readonly-observation'||e.observationReference!==intent.phase||e.effect.endsWith('_write')))throw Error('Open/reopen observation never grants a new write');
   if(e.after!==undefined&&(typeof e.after!=='string'||!e.after))throw Error('Invalid prerequisite');
   const cap=this.capabilities.get(e.api);if(!cap)throw Error('Effect capability is not actually selected');
   const expected=(cap.source==='app-state'?'local_':'external_')+(read(cap)?'read':'write');if(e.effect!==expected)throw Error('Effect facility/method mismatch');
   for(const dep of [e.after,e.when?.effect,...Object.values(e.arguments).map(a=>'fromEffect'in a?a.fromEffect:'unresolvedFromEffect'in a?a.unresolvedFromEffect:undefined)].filter(Boolean))if(!seen.has(dep!))throw Error('A prerequisite must name an earlier frozen effect');
   for(const a of Object.values(e.arguments))if(!a||typeof a!=='object'||!(Object.keys(a).length===1&&(Object.hasOwn(a,'literal')||['id','appRecordId'].includes((a as any).fromCurrentTarget)||typeof(a as any).unresolvedFromEffect==='string'&&Boolean((a as any).unresolvedFromEffect.trim()))||Object.keys(a).length===2&&typeof(a as any).fromEffect==='string'&&Boolean((a as any).fromEffect.trim())&&pointer((a as any).responsePointer)))throw Error('Invalid exact argument binding');
   for(const [argument,a]of Object.entries(e.arguments))if('unresolvedFromEffect'in a)this.bindingSlots.set(sha({scope:this.binding,effect:e.id,argument,sourceEffect:a.unresolvedFromEffect}),{effectId:e.id,argument,sourceEffect:a.unresolvedFromEffect});
   seen.add(e.id);
  }
  this.contractSha256=sha({scope:this.scope,effects:this.effects,capabilities:[...this.capabilities.values()]});
  // Functions are retained only by the existing host guard control flow. No
  // model/client approval JSON or public accept method can freeze a binding.
  hostHooks.registerReadPreflightConsumer?.((scope,call)=>this.#acceptBindings(scope,call,true));
  hostHooks.registerMutationVerifiedConsumer?.((scope,call)=>this.#acceptBindings(scope,call,false));
 }
 /** A next existing decision may propose pointers after seeing an actual query.
  * This only stages provenance candidates; no target is frozen or call allowed. */
 proposeBindings(scope:Scope,proposals:DeferredBindingProposal[]){
  if(sha(scope)!==this.binding||!Array.isArray(proposals))throw Error('Binding scope mismatch');
  const staged=new Map<string,BoundValue>();const states=this.snapshot().effects;
  for(const proposal of proposals){
   if(!objectKeys(proposal,['bindingId','receiptOrder','responsePointer'])||typeof proposal.bindingId!=='string'||!Number.isSafeInteger(proposal.receiptOrder)||!pointer(proposal.responsePointer)||staged.has(proposal.bindingId))throw Error('Malformed binding proposal');
   const slot=this.bindingSlots.get(proposal.bindingId);if(!slot)throw Error('Unknown host binding slot');
   const source=states.find(e=>e.id===slot.sourceEffect);if(source?.status!=='receipt_observed'||source.receiptOrder!==proposal.receiptOrder)throw Error('Binding source is not the actual frozen prerequisite receipt');
   const receipt=this.receipts.find(r=>r.order===proposal.receiptOrder)!;const value=at(receipt.response,proposal.responsePointer);
   const effect=this.effects.find(e=>e.id===slot.effectId)!;const schema=(this.capabilities.get(effect.api)!.inputSchema as any)?.properties?.[slot.argument];
   if(!schema)throw Error('No actual request schema for the unresolved argument');validateApiValue(value,schema,slot.argument);
   const candidate=plain({...proposal,value});const bound=this.boundValues.get(proposal.bindingId);if(bound&&wire(bound)!==wire(candidate))throw Error('Already-bound target is immutable');staged.set(proposal.bindingId,candidate);
  }
  for(const [id,value]of staged)this.pendingBindings.set(id,value);
  return{staged:[...staged.keys()],frozen:false,authority:'provenance-candidate-not-authorization'};
 }
 #acceptBindings(scope:Scope,actualGuardedCall:GuardedCall,readGuard:boolean){
  if(sha(scope)!==this.binding)throw Error('Guarded call scope mismatch');const call=plain(actualGuardedCall);const cap=this.capabilities.get(call.api);
  if(!cap||read(cap)!==readGuard)throw Error('Wrong host guard for actual capability method');
  if(!readGuard&&this.receipts.some(r=>r.outcome==='unknown'&&!read(this.capabilities.get(r.api)!)))throw Error('Unknown write remains locked');
  if(cap.inputSchema)validateApiValue(call.args,cap.inputSchema as any,call.api);
  const states=this.snapshot().effects;const candidates=this.effects.filter(e=>e.api===call.api).flatMap(e=>{
   const state=states.find(s=>s.id===e.id)!;if(state.status!=='ready'&&!(state.status==='blocked'&&state.reason==='Target binding awaits an existing host guard'))return[];
   const values:Record<string,unknown>={};const ids:string[]=[];
   for(const [name,arg]of Object.entries(e.arguments)){
    if('unresolvedFromEffect'in arg){const id=[...this.bindingSlots].find(([,slot])=>slot.effectId===e.id&&slot.argument===name)![0];const value=this.boundValues.get(id)??this.pendingBindings.get(id);if(!value)return[];values[name]=value.value;ids.push(id);}
    else if(state.resolvedArguments&&Object.hasOwn(state.resolvedArguments,name))values[name]=state.resolvedArguments[name];
    else if('literal'in arg)values[name]=arg.literal;
    else if('fromEffect'in arg){const source=states.find(s=>s.id===arg.fromEffect);if(source?.status!=='receipt_observed')return[];values[name]=at(this.receipts.find(r=>r.order===source.receiptOrder)!.response,arg.responsePointer);}
    else if('fromCurrentTarget'in arg&&this.scope.intent.source==='host-bound-current-row-action'){const value=this.scope.intent.targetEntity[arg.fromCurrentTarget];if(!value)return[];values[name]=value;}else return[];
   }
   return wire(values)===wire(call.args)?[{effect:e,ids}]:[];
  });
  if(candidates.length!==1)throw Error('Guarded target does not uniquely match one frozen effect');
  const accepted:string[]=[];for(const id of candidates[0].ids){if(!this.boundValues.has(id)){const value=this.pendingBindings.get(id);if(!value)throw Error('Unresolved target');this.boundValues.set(id,plain(value));accepted.push(id);}}
  return accepted;
 }
 /** These methods accept actual post-dispatch results, not proposed calls. Host
  * wiring must call them at the existing bridge/app-state dispatch boundary. */
 recordExternal(scope:Scope,order:number,result:AppWorldCallResult){
  const cap=this.capabilities.get(result.tool.apiName);if(!cap||cap.source!=='appworld'||cap.id!==result.tool.id||cap.method!==result.tool.method)throw Error('Actual external capability mismatch');
  this.record(scope,{api:cap.apiName,order,request:result.request,response:result.response,outcome:'succeeded',source:'appworld'});
 }
 recordLocal(scope:Scope,receipt:{api:string;order:number;request:unknown;response:unknown;ok:boolean;executionState:string;requestSource:string}){
  const cap=this.capabilities.get(receipt.api);if(!cap||cap.source!=='app-state'||receipt.ok!==true||receipt.executionState!=='succeeded'||receipt.requestSource!=='host-bound-app-state-dispatched-arguments')throw Error('Not an actual scoped local receipt');
  this.record(scope,{...receipt,outcome:'succeeded',source:'app-state'});
 }
 recordFailure(scope:Scope,api:string,order:number,outcome:'not_started'|'unknown',actualAttemptedRequest:unknown){
  const cap=this.capabilities.get(api);if(!cap)throw Error('Unknown dispatched capability');this.record(scope,{api,order,outcome,request:actualAttemptedRequest,response:null,source:cap.source});
 }
 private record(scope:Scope,r:Receipt){
  if(sha(scope)!==this.binding)throw Error('Receipt is not this exact owner/app/action/execution/message');
  if(!Number.isSafeInteger(r.order)||r.order<0||this.receipts.some(x=>x.order===r.order))throw Error('Actual receipt order must be unique');
  this.receipts.push(plain({...r,request:projectBusinessEvidence(r.request).value,response:projectBusinessEvidence(r.response).value}));
 }
 snapshot(){
  const states:Array<{id:string;api:string;effect:string;status:string;reason?:string;resolvedArguments?:Record<string,unknown>;receiptOrder?:number;inspectionOnly?:boolean}>=[];const observed=new Map<string,Receipt>(),unknownEffects=new Map<string,Receipt>(),consumedMutations=new Set<number>();
  const unknownWrite=this.receipts.some(r=>r.outcome==='unknown'&&!read(this.capabilities.get(r.api)!));
  for(const e of this.effects){
   const cap=this.capabilities.get(e.api)!;const state:any={id:e.id,api:e.api,effect:e.effect,status:'unmet'};
   try{
    const dependencies:Receipt[]=[];
    const prior=e.after?observed.get(e.after):undefined;
    if(e.after){if(prior)dependencies.push(prior);else {const unknown=unknownEffects.get(e.after);if(!read(cap)||!unknown)throw Error('Required preceding effect not observed');dependencies.push(unknown);state.inspectionOnly=true;}}
    if(e.when){const source=observed.get(e.when.effect);if(!source)throw Error('Condition needs an actual prerequisite read');if(!read(this.capabilities.get(source.api)!))throw Error('Condition must reference an actual read');dependencies.push(source);if(wire(at(source.response,e.when.responsePointer))!==wire(e.when.equals)){state.status='not_required_by_observed_condition';states.push(state);continue;}}
    const args=Object.fromEntries(Object.entries(e.arguments).map(([key,a])=>{if('literal'in a)return[key,a.literal];if('unresolvedFromEffect'in a){const source=observed.get(a.unresolvedFromEffect);if(!source)throw Error('Target source has no actual prerequisite receipt');dependencies.push(source);const id=[...this.bindingSlots].find(([,slot])=>slot.effectId===e.id&&slot.argument===key)![0];const bound=this.boundValues.get(id);if(!bound||bound.receiptOrder!==source.order)throw Error('Target binding awaits an existing host guard');return[key,bound.value];}if('fromCurrentTarget'in a){if(this.scope.intent.source!=='host-bound-current-row-action')throw Error('No actual current row target');const value=this.scope.intent.targetEntity[a.fromCurrentTarget];if(!value)throw Error('Current target identity is unresolved');return[key,value];}const source=observed.get(a.fromEffect);if(!source)throw Error('Target identifier has no actual preceding receipt');dependencies.push(source);return[key,at(source.response,a.responsePointer)];}));
    for(const name of cap.requiredParams??[])if(!Object.hasOwn(args,name))throw Error('Required API argument unresolved');
    if(cap.inputSchema)validateApiValue(args,cap.inputSchema as any,e.api);
    state.resolvedArguments=args;
    const dependencyOrder=Math.max(-1,...dependencies.map(r=>r.order));
    const sameRequest=this.receipts.filter(r=>r.api===e.api&&wire(r.request)===wire(args));
    const unknown=sameRequest.filter(r=>r.outcome==='unknown'&&r.order>dependencyOrder).sort((a,b)=>b.order-a.order)[0];
    if(unknown&&!read(cap))unknownEffects.set(e.id,unknown);
    const matches=sameRequest.filter(r=>r.outcome==='succeeded'&&r.order>dependencyOrder);
    if(!read(cap)&&matches.length>1)throw Error('Multiple successful writes match; never choose or replay one by guess');
    // The first matching read pins a prerequisite target for this frozen turn;
    // later search results cannot silently retarget an already-created object.
    const receipt=matches.sort((a,b)=>a.order-b.order)[0];
    if(receipt){if(!read(cap)){if(consumedMutations.has(receipt.order))throw Error('One mutation receipt cannot satisfy distinct effects; resolve the duplicate contract, never automatically create another object');consumedMutations.add(receipt.order);}state.status='receipt_observed';state.receiptOrder=receipt.order;observed.set(e.id,receipt);}
    else {if(!read(cap)&&unknownWrite)throw Error('Unknown write outcome: retain prior IDs, inspect state, never replay writes');if(!read(cap)&&sameRequest.some(r=>r.outcome==='succeeded'))throw Error('Successful write predates a prerequisite; inspect it, never replay to repair ordering');state.status='ready';}
   }catch(error){state.status='blocked';state.reason=String((error as Error).message);}
   states.push(state);
  }
  return{schema:'native-operation-progress-candidate-v1',authority:'progress-only-not-authorization-or-semantic-success',contractSha256:this.contractSha256,currentIntentSha256:sha(this.scope.intent),effects:states,bindings:[...this.bindingSlots].map(([bindingId,slot])=>({bindingId,...slot,state:this.boundValues.has(bindingId)?'bound':'unresolved',...(this.boundValues.has(bindingId)?{receiptOrder:this.boundValues.get(bindingId)!.receiptOrder,responsePointer:this.boundValues.get(bindingId)!.responsePointer}: {})})),ready:states.filter(s=>s.status==='ready'),unmet:states.filter(s=>!['receipt_observed','not_required_by_observed_condition'].includes(s.status)),hasUnknownWrite:unknownWrite,allRequiredReceiptsObserved:!unknownWrite&&states.every(s=>['receipt_observed','not_required_by_observed_condition'].includes(s.status)),recordedReceiptCount:this.receipts.length};
 }
}

/** This schema guides the existing Requirement/decision calls; it is not a new
 * role, authority grant, execution gate, or claim that a fallible plan is true. */
export const operationProgressPolicy='Optional execution progress proposal: in the SAME Requirement JSON you may add requiredEffects:[{id,api,effect:"external_read"|"external_write"|"local_read"|"local_write",requestQuote?:string,rowActionReference?:{actionId,targetEntityId},observationReference?:"initial_open"|"reopen",arguments:{argumentName:{literal:value}|{unresolvedFromEffect:earlierEffectId}},after?:earlierEffectId}]. Use exactly one current intent reference per effect. Readonly initial/reopen never authorizes writes. API names/methods/request fields come only from authorizedOperationCatalog/appStateCapabilities; availability is not user authorization. Use current explicit request/event, never invent an obligation from app purpose or UI metadata. Unknown response shape or ID MUST use unresolvedFromEffect, never guess a pointer or identifier before querying. A next existing executor decision may include bindings:[{bindingId,receiptOrder,responsePointer}] alongside its normal calls, taking exact scalar values from actual host receipts already supplied. A pointer proves provenance, not correct business selection. Preserve reserved user choice; existing write verification still judges every mutation. No plan may weaken user constraints, grant permissions, replay successful or unknown writes, or replace required external effects with local tracking. operationProgress is fallible structural progress only: reuse confirmed created IDs, propose only the remaining authorized work, and read back the changed target. Missing/invalid effects or an unmet proposed effect are not by themselves proof of business failure, and allRequiredReceiptsObserved is never proof of semantic success. Judge the original/current user goal using actual evidence.';
