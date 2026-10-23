/** Validate job overrides before they enter the queue. Secrets never enter persisted job metadata. */
export function resolveJobModel(input, defaultModel, {modelSelection=true,providerOverride=true,modelOnly=true}={}) {
  const model=input.model===undefined?defaultModel:input.model;
  if(typeof model!=='string'||!model.trim()||model.length>200||/[\x00-\x1f\x7f]/.test(model))throw Object.assign(new Error('Invalid model ID'),{status:400,code:'model_invalid'});
  if(!modelSelection&&model!==defaultModel)throw Object.assign(new Error('This runner cannot change models'),{status:422,code:'harness_model_unsupported'});
  let provider;
  if(input.provider!==undefined){
    if(!providerOverride)throw Object.assign(new Error('This runner cannot change providers'),{status:422,code:'harness_provider_unsupported'});
    const raw=input.provider;
    if(!raw||typeof raw.apiKey!=='string'||!raw.apiKey.trim()||raw.apiKey.length>8192||typeof raw.apiBase!=='string')throw Object.assign(new Error('Invalid provider configuration'),{status:400,code:'provider_invalid'});
    let url;try{url=new URL(raw.apiBase);}catch{throw Object.assign(new Error('Invalid provider URL'),{status:400,code:'provider_invalid'});}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Object.assign(new Error('Provider URL must use HTTP(S) without embedded credentials or query'),{status:400,code:'provider_invalid'});
    provider={apiBase:raw.apiBase.replace(/\/+$/,''),apiKey:raw.apiKey};
  }
  if(!provider&&!modelOnly&&model!==defaultModel)throw Object.assign(new Error('This runner needs a provider configuration to use another model'),{status:422,code:'harness_provider_required'});
  return {model:model.trim(),provider};
}

export function providerPatch(model, compat = false) {
  // A dedicated provider avoids changing another app's profile. Values come from child-only env.
  const patch=`- id: agent-default-model\n  config:\n    provider: liveui\n    model: ${JSON.stringify(model)}\n- id: llm-pi-ai\n  config:\n    providers:\n      liveui:\n        api: openai-completions\n        baseURL: !!js process.env.LIVEUI_LLM_API_BASE\n        apiKeyEnv: LIVEUI_LLM_API_KEY\n        models:\n          - id: ${JSON.stringify(model)}\n            name: ${JSON.stringify(model)}\n            contextWindow: 131072\n            input: [text]\n`;
  return compat ? patch.replace('        models:\n','        compat:\n          supportsStore: false\n          supportsDeveloperRole: false\n          supportsReasoningEffort: false\n          thinkingFormat: deepseek\n        models:\n')+'            reasoningEfforts: {off: null, high: high}\n' : patch;
}
