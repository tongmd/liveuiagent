import {createHash,randomBytes} from 'node:crypto';
import type {InteractionStep,VisibleSnapshot} from './gui-interaction-planner.js';
export type GuiPreparationHostContext={completeMissing:(preparation:unknown)=>unknown;validated:(preparation:unknown)=>void};
const invalid=()=>Object.assign(Error('GUI field proof is stale, unavailable or outside its original episode binding'),{status:409,code:'gui_field_proof_invalid'});
const changed=()=>Object.assign(Error('GUI field proof business scope changed; end this episode and do not automatically repeat its action'),{status:409,code:'gui_field_proof_scope_changed'});
const clone=<T>(x:T):T=>structuredClone(x);
const fieldSignature=(f:any)=>[f.target,f.componentId,f.label,f.tag,f.type,f.options??null,!!f.required,!!f.disabled,!!f.readOnly];
const signatures=(v:VisibleSnapshot)=>JSON.stringify(v.fields.map(fieldSignature));
const buttonSignature=(b:any)=>JSON.stringify([b?.target,b?.componentId,b?.label,b?.actionId,b?.contextText??'',!!b?.disabled]);
const binding=(owner:string,input:any)=>JSON.stringify([owner,input.appId,input.harness,input.model,createHash('sha256').update(input.userMessage).digest('hex')]);
type Entry={scope:string;slot:string;epoch:number;expires:number;steps:number;preparation:any;view:VisibleSnapshot;businessEpoch:string;observationClicks:string[]};
/** Process-local, bounded, one-use planning evidence. Never a business permission. */
export class GuiFieldProofs{
 private nextEpoch=0;private entries=new Map<string,Entry>();private epochs=new Map<string,{epoch:number;expires:number}>();
 constructor(private now=Date.now,private maximum=256){}
 discard(token:string){this.entries.delete(token);}
 begin(owner:string,input:any,parentRemaining:number,businessEpoch:string){
  const now=this.now();for(const[t,e]of this.entries)if(e.expires<=now)this.entries.delete(t);for(const[s,e]of this.epochs)if(e.expires<=now)this.epochs.delete(s);
  const observationClicks=(input.observations??[]).filter((o:any)=>o.step?.kind==='click').map((o:any)=>JSON.stringify(o));
  const scope=binding(owner,input),slot=JSON.stringify([owner,input.appId]);let previous:Entry|undefined;
  if(input.fieldProof!==undefined){
   previous=this.entries.get(input.fieldProof);this.entries.delete(input.fieldProof); // atomic consume before any await/model call
   if(!previous||previous.scope!==scope||previous.slot!==slot||previous.expires<=now||previous.steps>=40||this.epochs.get(slot)?.epoch!==previous.epoch)throw invalid();
   if(previous.businessEpoch!==businessEpoch||observationClicks.length!==previous.observationClicks.length||observationClicks.some((v:string,i:number)=>v!==previous!.observationClicks[i]))throw changed();
  }else{
   for(const[t,e]of this.entries)if(e.slot===slot)this.entries.delete(t);
   if(!this.epochs.has(slot)&&this.epochs.size>=this.maximum)throw invalid();
   this.epochs.set(slot,{epoch:++this.nextEpoch,expires:now+Math.min(1200000,input.remainingBudgetMs??1200000,parentRemaining)});
  }
  const epoch=this.epochs.get(slot)!.epoch;
  const expires=Math.min(previous?.expires??Infinity,now+Math.min(1200000,input.remainingBudgetMs??1200000,parentRemaining));
  let validated:any;
  const host:GuiPreparationHostContext={
   completeMissing:raw=>{
    if(!previous)return raw;
    const p=raw as any;if(!p||['done','unsupported'].includes(p.action?.kind))return raw;if(p.action?.kind!=='click'||!Array.isArray(p.fields))throw invalid();
    const selected=input.snapshot.buttons.find((b:any)=>b.target===p.action.target),prior=previous.view.buttons.find((b:any)=>b.target===previous!.preparation.action.target);
    if(p.action.target!==previous.preparation.action.target||buttonSignature(selected)!==buttonSignature(prior)||signatures(input.snapshot)!==signatures(previous.view))throw invalid();
    const provided=new Set(p.fields.map((f:any)=>f?.target));const additions:any[]=[];
    for(const field of input.snapshot.fields.filter((f:any)=>!f.disabled&&!f.readOnly)){
     if(provided.has(field.target))continue;
     const approved=previous.preparation.fields.find((f:any)=>f.target===field.target),old=previous.view.fields.find(f=>f.target===field.target);if(!approved||!old)throw invalid();
     const boolean=['checkbox','radio','switch'].includes(field.type);
     const expected=approved.binding==='current'?(boolean?approved.checked:approved.value):(boolean?old.checked:old.value);
     const actual=boolean?field.checked:field.value;
     const same=actual===expected||(!boolean&&['number','range'].includes(field.type)&&String(actual).trim()!==''&&String(expected).trim()!==''&&Number.isFinite(Number(actual))&&Number(actual)===Number(expected));
     if(!same)throw invalid();additions.push(clone(approved));
    }
    return {...p,fields:[...p.fields,...additions]};
   },
   validated:raw=>{validated=clone(raw);},
  };
  return {host,finish:(step:InteractionStep)=>{
   if(this.epochs.get(slot)?.epoch!==epoch)throw invalid();
   const prep=validated;const canIssue=['fill','select','check'].includes(step.kind)&&prep?.action?.kind==='click'&&input.snapshot.fields.every((f:any)=>typeof f.componentId==='string'&&f.componentId.length>0);
   if(!canIssue){this.epochs.delete(slot);return undefined;}
   if(expires<=this.now()||(previous?.steps??0)+1>=40)throw invalid();
   if(this.entries.size>=this.maximum)throw invalid();
   const token=randomBytes(32).toString('hex');this.entries.set(token,{scope,slot,epoch,expires,steps:(previous?.steps??0)+1,preparation:prep,view:clone(input.snapshot),businessEpoch,observationClicks});return token;
  },abort:()=>{if(this.epochs.get(slot)?.epoch===epoch){this.epochs.delete(slot);for(const[t,e]of this.entries)if(e.slot===slot)this.entries.delete(t);}}};
 }
}
