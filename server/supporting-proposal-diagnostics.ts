import path from 'node:path';
import {projectBusinessEvidence} from './grounding-evidence.js';
import {writePrivateDiagnostics} from './grounding-diagnostics.js';
/** Default-off private structural proposal, not reasoning or a business receipt. */
export function writeSupportingProposalDiagnostics(raw:unknown,round:number,step:number,explicitApiKey?:string){
 const root=process.env.LIVEUIAGENT_GROUNDING_DIAGNOSTICS_ROOT;if(!root||raw===undefined)return undefined;
 try{
  const cot=(v:any):boolean=>Boolean(v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>/^(?:reason(?:ing)?(?:_content)?|analysis|thoughts?|chain_of_thought)$/i.test(k)||cot(x)));
  const p=projectBusinessEvidence(raw,'supportingSections'),text=JSON.stringify(p.value);const key=String(explicitApiKey||process.env.OPENAI_API_KEY||'').trim();
  const omittedReason=key&&[key,JSON.stringify(key).slice(1,-1)].some(k=>text.includes(k))?'provider_secret_detected':cot(raw)||/<(?:think|analysis|reasoning)>/i.test(text)?'explicit_reasoning_not_recorded':Buffer.byteLength(text)>262144?'proposal_size_limit':undefined;
  return writePrivateDiagnostics(path.join(root,'supporting-proposal-diagnostics'),{stage:'supporting-proposal',round,step,...(omittedReason?{proposalOmitted:omittedReason}:{supportingSections:p.value}),omittedAuthPaths:p.omittedAuthenticationKeys,rawModelResponseCaptured:false,providerReasoningCaptured:false},'Private unverified supporting-section proposal. No automatic upload, business replay or change in verdict. Over-limit proposals are omitted whole, never truncated. Known-key protection does not detect arbitrary free-text secrets.');
 }catch{return{status:'not_written' as const,reason:'diagnostics_unavailable' as const};}
}
