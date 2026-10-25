import {createHash} from 'node:crypto';
export type NativeActionNotStartedProof={schema:'native-action-not-started-v1';status:'failed';executionId:string;appId:string;actionId:string;eventPayloadSha256:string;executorEntered:false;dispatchEvidence:{basis:'executor-not-entered';businessDispatchAttempts:0;unknownDispatchOutcomes:0};automaticRetry:false};
const hostProofs=new WeakMap<object,NativeActionNotStartedProof>();
export function normalizeNativeActionId(value:string){return value.replace(/^actions\./,'').trim();}
/** Canonicalize the JSON values actually transmitted, not JS-only metadata. */
export function nativeActionPayloadSha256(payload:unknown):string{
 const json=JSON.parse(JSON.stringify(payload));
 const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 return createHash('sha256').update(canonical(json)).digest('hex');
}
/** Called only by the host before entry to its business executor. Zero attempts
 * are a consequence of non-entry, not a fabricated whole-stage/global counter. */
export function markNativeActionNotStarted(error:unknown,binding:{executionId:string;appId:string;actionId:string;eventPayload:unknown}){
 if(!error||typeof error!=='object')return;
 const proof:NativeActionNotStartedProof={schema:'native-action-not-started-v1',status:'failed',executionId:binding.executionId,appId:binding.appId,actionId:normalizeNativeActionId(binding.actionId),eventPayloadSha256:nativeActionPayloadSha256(binding.eventPayload),executorEntered:false,dispatchEvidence:{basis:'executor-not-entered',businessDispatchAttempts:0,unknownDispatchOutcomes:0},automaticRetry:false};
 hostProofs.set(error,proof);
}
/** Plain fields on model/provider-thrown errors are never trusted as host proof. */
export function hostNativeActionNotStartedProof(error:unknown){return error&&typeof error==='object'?hostProofs.get(error):undefined;}
export function validateNativeActionNotStartedProof(value:unknown,binding:{appId:string;actionId:string;eventPayload:unknown}):value is NativeActionNotStartedProof{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const p=value as any;const keys=['schema','status','executionId','appId','actionId','eventPayloadSha256','executorEntered','dispatchEvidence','automaticRetry'];
 if(Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k)))return false;
 const e=p.dispatchEvidence;
 return Boolean(p.schema==='native-action-not-started-v1'&&p.status==='failed'&&typeof p.executionId==='string'&&p.executionId.length>0&&p.executionId.length<=100&&p.appId===binding.appId&&p.actionId===normalizeNativeActionId(binding.actionId)&&p.eventPayloadSha256===nativeActionPayloadSha256(binding.eventPayload)&&p.executorEntered===false&&p.automaticRetry===false&&e&&typeof e==='object'&&!Array.isArray(e)&&Object.keys(e).length===3&&e.basis==='executor-not-entered'&&e.businessDispatchAttempts===0&&e.unknownDispatchOutcomes===0);
}
export function nativeActionFingerprint(binding:{appId:string;actionId:string;eventPayload:unknown}){return JSON.stringify([binding.appId,normalizeNativeActionId(binding.actionId),nativeActionPayloadSha256(binding.eventPayload)]);}
