import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const canonicalPath='/context/currentState/lastActionPayload/toolResults';
const aliasPaths=['/context/records/agent_turns/0/toolResults'] as const;
function canonical(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return Object.is(value,-0)?'-0':JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as any)[key])).join(',')+'}';
 throw Error('Evidence is not a plain finite JSON value');
}
function sha(text:string){return createHash('sha256').update(text).digest('hex');}
function wire(value:unknown){return JSON.stringify(value);}
function at(input:any,path:string){return path.slice(1).split('/').reduce((value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined,input);}
function set(input:any,path:string,value:unknown){const keys=path.slice(1).split('/');const key=keys.pop()!;const parent=keys.reduce((value,key)=>value[key],input);parent[key]=value;}
export type PlanFactorReceipt={version:1;sourceRepresentation:'model-wire-json';factored:boolean;sourceBytes:number;modelBytes:number;sourceSha256:string;modelSha256:string;aliases:Array<{path:string;sourcePath:string;sha256:string}>};
/** Only one known host-owned duplicate location may share the complete canonical
 * last-action evidence. Arbitrary user objects and unequal values are untouched. */
export function factorNativePlanInput(original:Record<string,unknown>):{input:Record<string,unknown>;receipt:PlanFactorReceipt}{
 // Match the actual model transport boundary, not ephemeral JS prototypes or
 // optional undefined properties that JSON.stringify never sends. Serialization
 // errors still throw; the caller's original trace object is never rewritten.
 const before=wire(original);const source:Record<string,unknown>=JSON.parse(before);
 const input=structuredClone(source);const aliases:PlanFactorReceipt['aliases']=[];
 const evidence=at(source,canonicalPath);
 if(evidence&&typeof evidence==='object'&&!Object.hasOwn(source,'hostPlanEvidenceFactorization')){
  try{
   const bytes=canonical(evidence);
   if(aliasPaths.every(path=>canonical(at(source,path))===bytes&&wire(at(source,path))===wire(evidence))){
    const hash=sha(bytes);
    for(const path of aliasPaths){set(input,path,{hostSharedPlanEvidence:{sourcePath:canonicalPath,sha256:hash}});aliases.push({path,sourcePath:canonicalPath,sha256:hash});}
    input.hostPlanEvidenceFactorization={version:1,policy:'Exact shared copies, not omitted facts. Every alias denotes the entire unchanged canonical toolResults including every request, response, dbChanges and ordered call. All other records, facts and permissions remain unchanged. This does not establish business success.',aliases};
   }
  }catch{/* Non-JSON/missing/different evidence remains fully inline. */}
 }
 const after=wire(input);const receipt:PlanFactorReceipt={version:1,sourceRepresentation:'model-wire-json',factored:aliases.length===1,sourceBytes:Buffer.byteLength(before),modelBytes:Buffer.byteLength(after),sourceSha256:sha(before),modelSha256:sha(after),aliases};
 // Fail closed if even one serialized model-input fact or wire byte is lost.
 if(!isDeepStrictEqual(restoreNativePlanInput(input,receipt),source))throw Error('Native plan factorization is not lossless');
 return{input,receipt};
}
/** The caller supplies the host receipt, never a model/API-authored reference.
 * Resolve only these exact locations once; nested lookalike markers are data. */
export function restoreNativePlanInput(projected:Record<string,unknown>,receipt:PlanFactorReceipt):Record<string,unknown>{
 if(receipt.version!==1||sha(wire(projected))!==receipt.modelSha256)throw Error('Plan projection hash mismatch');
 const restored=structuredClone(projected);
 if(receipt.factored){
  if(receipt.aliases.length!==1||receipt.aliases.some((alias,index)=>alias.path!==aliasPaths[index]||alias.sourcePath!==canonicalPath))throw Error('Invalid plan evidence alias scope');
  const evidence=at(projected,canonicalPath);const hash=sha(canonical(evidence));
  for(const alias of receipt.aliases){if(alias.sha256!==hash||!isDeepStrictEqual(at(projected,alias.path),{hostSharedPlanEvidence:{sourcePath:canonicalPath,sha256:hash}}))throw Error('Review evidence alias mismatch');set(restored,alias.path,structuredClone(evidence));}
  delete restored.hostPlanEvidenceFactorization;
 }else if(receipt.aliases.length)throw Error('Unexpected plan evidence aliases');
 if(sha(wire(restored))!==receipt.sourceSha256)throw Error('Restored plan source hash mismatch');
 return restored;
}
