/** Application-owned Native DSH policy. No provider globals or deadlines change. */
export const NATIVE_STRUCTURED_JSON_POLICY='native-deepseek-structured-json-v1';
export const NATIVE_STRUCTURED_JSON_MAX_TOKENS=8192;
export const NATIVE_BUSINESS_THINKING_LOW_POLICY='native-deepseek-business-thinking-low-experiment-v1';
const businessRoles=new Set(['Grounding Requirement Agent','AppWorld Grounding Agent','Write Verifier Agent','Grounding Evaluator Agent','Command orchestrator','Command scope reviewer','Command planner','Independent result verifier']);
export type NativeJsonExperiment={experimentalBusinessThinking?:'enabled-low';roleLabel?:string};
function scoped(request:Record<string,unknown>){
 const format=request.response_format as {type?:unknown}|undefined;
 return /(^|\/)deepseek(?:[-_.]|$)/i.test(String(request.model||''))&&Boolean(format&&['json_object','json_schema'].includes(String(format.type)));
}
export function applyNativeStructuredJsonPolicy(request:Record<string,unknown>, experiment:NativeJsonExperiment={}):Record<string,unknown>{
 if(!scoped(request))return request;
 const caps=['max_tokens','max_completion_tokens'].filter(key=>Object.hasOwn(request,key)).map(key=>{
  const value=request[key];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw Object.assign(Error('Native structured JSON token cap must be a positive safe integer'),{code:'native_json_policy_invalid_cap'});return value;
 });
 if(experiment.experimentalBusinessThinking!==undefined&&experiment.experimentalBusinessThinking!=='enabled-low')throw Error('Unsupported Native business thinking experiment');
 const low=experiment.experimentalBusinessThinking==='enabled-low'&&businessRoles.has(experiment.roleLabel||'');
 const result={...request,thinking:{type:low?'enabled':'disabled'},reasoning_effort:low?'low':'none',max_tokens:Math.min(NATIVE_STRUCTURED_JSON_MAX_TOKENS,...caps)};
 // Keep a single explicit host cap; never retain an adapter's competing default.
 delete (result as Record<string,unknown>).max_completion_tokens;
 // An inherited generic provider reasoning object cannot contradict this role policy.
 delete (result as Record<string,unknown>).reasoning;
 return result;
}
/** Only enumerated actual request parameters, never prompts/provider credentials. */
export function nativeStructuredJsonPolicyMetadata(request:Record<string,unknown>){
 if(!scoped(request))return undefined;
 const thinking=request.thinking as {type?:unknown}|undefined;
 const low=thinking?.type==='enabled'&&request.reasoning_effort==='low';
 const off=thinking?.type==='disabled'&&request.reasoning_effort==='none';
 if((!low&&!off)||typeof request.max_tokens!=='number'||!Number.isSafeInteger(request.max_tokens)||request.max_tokens<1||request.max_tokens>NATIVE_STRUCTURED_JSON_MAX_TOKENS||Object.hasOwn(request,'max_completion_tokens')||Object.hasOwn(request,'reasoning'))return undefined;
 return {id:low?NATIVE_BUSINESS_THINKING_LOW_POLICY:NATIVE_STRUCTURED_JSON_POLICY,responseFormat:String((request.response_format as {type:string}).type),thinking:low?'enabled':'disabled',reasoningEffort:low?'low':'none',maxTokens:request.max_tokens};
}
