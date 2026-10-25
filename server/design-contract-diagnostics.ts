import path from 'node:path';
import {createHash} from 'node:crypto';
import {writePrivateDiagnostics} from './grounding-diagnostics.js';
const proposalKeys=['appName','tagline','accent','slots','persistedDomainFields','actions','services','itemLabel','primaryMembership','glyph','metric','metricLabel','collection','tileTagline','actionVerb'];
const excluded=/^(?:reason|reasoning.*|analysis|thoughts?|chain_of_thought|provider.*|api[_-]?(?:base|url|key)|endpoint|headers|messages|system|trace|authorization|password|secret|token|access_token|refresh_token|credentials?)$/i;
type Stage='initial'|'schema-refinement';
type References={aliasTrace:{references:unknown[]};rawDeclarations:unknown};
function write(stage:Stage,attempt:1|2,raw:unknown,details:Record<string,unknown>){
 const root=process.env.LIVEUIAGENT_DESIGN_DIAGNOSTICS_ROOT;if(!root)return undefined;
 try{
  const omitted:string[]=[];
  const project=(value:unknown,at:string):unknown=>Array.isArray(value)?value.map((item,index)=>project(item,`${at}/${index}`)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{if(excluded.test(key)){omitted.push(`${at}/${key}`);return [];}return [[key,project(item,`${at}/${key}`)]];})):value;
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  for(const key of Object.keys(source))if(!proposalKeys.includes(key))omitted.push('/'+key);
  const proposal=project(Object.fromEntries(proposalKeys.filter(key=>Object.hasOwn(source,key)).map(key=>[key,source[key]])),'');
  return writePrivateDiagnostics(path.join(root,'design-contract-diagnostics'),{stage,attempt,proposal,rawProposalSha256:createHash('sha256').update(JSON.stringify(raw)??'undefined').digest('hex'),...project(details,'/diagnostic') as object,omittedProposalPaths:omitted,callPolicy:'Initial design may add at most one explicit contract-repair SDK call; schema refinement has its own existing one-repair limit. Each stage shares its original deadline. Transport/parse/refusal never repair.'},'Private structured design audit. A declaration reference proves only exact equivalent declarations, not stored values, business success or permission to replay. Defaults off; provider configuration, personal memory and free-form model reasoning are not recorded. Authentication-key projection follows the shared private audit writer.');
 }catch{return{status:'not_written' as const,reason:'diagnostics_unavailable' as const};}
}
/** Defaults off; audit IO failure cannot change a design verdict or retry. */
export function writeDesignContractDiagnostics(stage:Stage,attempt:1|2,raw:unknown,error:unknown){return write(stage,attempt,raw,{status:'strict_contract_rejected',validationMessage:String((error as Error)?.message??error)});}
export function writeDesignReferenceDiagnostics(stage:Stage,attempt:1|2,raw:unknown,resolved:References){
 if(!resolved.aliasTrace.references.length)return undefined;
 return write(stage,attempt,raw,{status:'canonicalized_declaration_references',aliasTrace:resolved.aliasTrace,rawDeclarations:resolved.rawDeclarations});
}
