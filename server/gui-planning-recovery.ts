import {AsyncLocalStorage}from'node:async_hooks';import{createHash,randomBytes}from'node:crypto';
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export type GuiNativeAttempt={id:string;model:string;role:string;effectiveDeadlineAt:number;registered:boolean;completed:boolean;success:boolean;eligibleEof:boolean;requestSha256:string};
export type GuiAttemptContext={attempts:GuiNativeAttempt[];transportDeadlineAt?:number};
const contexts=new AsyncLocalStorage<GuiAttemptContext>();
export function noteGuiTransportDeadline(deadlineAt:number){const c=contexts.getStore();if(c&&Number.isFinite(deadlineAt))c.transportDeadlineAt=Math.min(c.transportDeadlineAt??deadlineAt,deadlineAt);}
/** Only the standard host NativeDSH producer records evidence. Not user/model JSON. */
export function withGuiAttemptContext<T>(context:GuiAttemptContext,work:()=>T):T{return contexts.run(context,work);}
export function beginRegisteredGuiNativeAttempt(input:{id:string;model:string;role:string;effectiveDeadlineAt:number;request:unknown;standardProducer:boolean}):GuiNativeAttempt|undefined{
 const context=contexts.getStore();if(!context||!input.standardProducer||input.role!=='Native GUI Step Planner')return undefined;
 const attempt:GuiNativeAttempt={id:input.id,model:input.model,role:input.role,effectiveDeadlineAt:Math.min(input.effectiveDeadlineAt,context.transportDeadlineAt??input.effectiveDeadlineAt),requestSha256:hash(input.request),registered:true,completed:false,success:false,eligibleEof:false};context.attempts.push(attempt);return attempt;
}
export type PlanningRecovery={schema:'native-gui-pure-planning-recovery-v1';token:string;effectiveDeadlineAt:number;initialInvocationId:string;kind:'transport_eof'|'contract_invalid';remainingRecoveries:1};
const proofs=new WeakMap<object,PlanningRecovery>();
export function hostPlanningRecovery(error:unknown):PlanningRecovery|undefined{return error&&typeof error==='object'?proofs.get(error):undefined;}
export function attachPlanningRecovery(error:object,proof:PlanningRecovery){proofs.set(error,proof);}
function invalid(){return Object.assign(Error('GUI planning recovery is invalid, expired or already consumed; no inference repeated'),{status:400,code:'gui_planning_recovery_invalid',plannerModelCalls:0});}
export function planningRecoveryBinding(owner:string,input:any,businessEpoch:string|undefined){return hash({owner,appId:input.appId,harness:input.harness,model:input.model,userMessage:input.userMessage,snapshot:input.snapshot,observations:input.observations,businessEpoch});}
/** One host-held ticket is shared by transport and JSON-contract recovery. */
export class GuiPlanningRecoveryTickets{
 private tickets=new Map<string,{binding:string;proof:PlanningRecovery;steps:number;clicks:number}>();
 issue(error:object,binding:string,input:any,context:GuiAttemptContext,initialDeadlineAt:number,kind:PlanningRecovery['kind']):PlanningRecovery|undefined{
  const a=context.attempts[0];if(input.harness!=='dsh'||context.attempts.length!==1||!a?.registered||!a.completed||a.model!==input.model||a.role!=='Native GUI Step Planner'||!(kind==='transport_eof'?a.eligibleEof:a.success)||!Number.isSafeInteger(input.stepsRemaining)||input.stepsRemaining<=1||!Number.isSafeInteger(input.clicksRemaining))return;
  const deadline=Math.min(initialDeadlineAt,a.effectiveDeadlineAt);if(Date.now()>=deadline)return;
  for(const[k,t]of this.tickets)if(t.proof.effectiveDeadlineAt<=Date.now())this.tickets.delete(k);if(this.tickets.size>=512)return;
  const token=randomBytes(32).toString('hex'),proof:PlanningRecovery={schema:'native-gui-pure-planning-recovery-v1',token,effectiveDeadlineAt:deadline,initialInvocationId:a.id,kind,remainingRecoveries:1};this.tickets.set(token,{binding,proof,steps:input.stepsRemaining,clicks:input.clicksRemaining});attachPlanningRecovery(error,proof);return proof;
 }
 consume(token:string,binding:string,input:any){const t=this.tickets.get(token);this.tickets.delete(token);if(!t||t.binding!==binding||Date.now()>=t.proof.effectiveDeadlineAt||input.stepsRemaining!==t.steps-1||input.clicksRemaining!==t.clicks)throw invalid();return t.proof;}
}
