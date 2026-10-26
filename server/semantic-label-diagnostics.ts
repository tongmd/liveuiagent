import path from'node:path';
import{projectBusinessEvidence}from'./grounding-evidence.js';
import{writePrivateDiagnostics}from'./grounding-diagnostics.js';
import{SemanticLabelValidationError}from'./native-surface-design.js';
/** Private structured heading proposal only; never raw model responses, CoT or an uploader. */
export function writeSemanticLabelDiagnostics(attempt:number,raw:unknown,error:unknown,explicitApiKey?:string){
 const root=process.env.LIVEUIAGENT_DESIGN_DIAGNOSTICS_ROOT;if(!root||!(error instanceof SemanticLabelValidationError))return undefined;
 try{
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  const headings=source.headings&&typeof source.headings==='object'&&!Array.isArray(source.headings)?source.headings as Record<string,unknown>:{};
  const explicitCoT=(v:unknown):boolean=>Boolean(v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>/^(?:reason(?:ing)?(?:_content)?|analysis|thoughts?|chain_of_thought)$/i.test(k)||explicitCoT(x)));
  const labels=Object.fromEntries(['records','composer'].filter(k=>typeof headings[k]==='string').map(k=>[k,headings[k]]));
  const projected=projectBusinessEvidence(labels,'headings');const text=JSON.stringify(projected.value);
  // Match openAIChatJson exactly: empty explicit key falls back, whitespace does
  // not fall back before trim. Adapter-internal provider values are not inferred.
  const knownEffectiveKey=String(explicitApiKey||process.env.OPENAI_API_KEY||'').trim();
  const secretHit=Boolean(knownEffectiveKey&&[knownEffectiveKey,JSON.stringify(knownEffectiveKey).slice(1,-1)].some(v=>text.includes(v)));
  const explicitMarker=Object.values(labels).some(v=>typeof v==='string'&&/<(?:think|analysis|reasoning)>/i.test(v));
  // 64KiB bounds only the candidate-headings JSON, not the final diagnostic envelope.
  const omittedReason=secretHit?'provider_secret_detected':explicitCoT(source)||explicitMarker?'explicit_reasoning_not_recorded':Buffer.byteLength(text)>65536?'proposal_size_limit':undefined;
  return writePrivateDiagnostics(path.join(root,'semantic-label-diagnostics'),{stage:'semantic-surface-label-validation',attempt,diagnostic:error.diagnostic,...(omittedReason?{proposalOmitted:omittedReason}:{proposal:{headings:projected.value}}),omittedAuthPaths:projected.omittedAuthenticationKeys,modelRawResponseCaptured:false,providerReasoningCaptured:false,guardUnchanged:true},'Private heading proposal diagnostic; generated text is unverified. Known authentication-key/provider exact protection does not detect arbitrary secrets in free text. No automatic upload or business replay.');
 }catch{return{status:'not_written' as const,reason:'diagnostics_unavailable' as const};}
}
