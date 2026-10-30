import {harnessCatalog,harnessDefinition,harnessModels,selectHarnessModel,isDomesticHarness,type HarnessId,type DomesticHarnessId} from './harness-catalog.js';
import type {HarnessChoice} from './runtime-settings.js';
import type {LlmRuntimeConfig} from './liveuiagent.js';
import type {createCodexNativeInference} from './codex-native-inference.js';
import type {createDshNativeInference} from './dsh-native-inference.js';
import type {createDomesticHarnessInference} from './domestic-harness-inference.js';

type Selection = {owner:string;models:readonly string[];model?:string;keySource?:string;legacyCapabilities:()=>Promise<{model?:string;modelSelection?:boolean;providerOverride?:boolean}>};
type Connection = Selection & {appId?:string;delivery?:unknown;personalContext:string;requested:Record<string,string>;resolve:(requested:Record<string,string>)=>LlmRuntimeConfig|undefined};
type Adapter = {
  availability:(selection:Selection)=>string|undefined;
  model:(selection:Selection)=>Record<string,unknown>|Promise<Record<string,unknown>>;
  connect:(context:Connection)=>LlmRuntimeConfig|undefined;
};
const failure=(message:string,code:string,status=503)=>Object.assign(new Error(message),{code,status});

/** One host entrypoint for advertising, selecting and connecting every harness.
 * Adapters retain their authentication and transport; application execution and
 * persistence stay with the host. No adapter may fall back to another harness. */
export function createHarnessIntegration(input:{
  codex:ReturnType<typeof createCodexNativeInference>;
  dsh:ReturnType<typeof createDshNativeInference>|undefined;
  domestic:Partial<Record<DomesticHarnessId,ReturnType<typeof createDomesticHarnessInference>|undefined>>;
  htmlConfigured:()=>boolean;
}) {
  const providerModel=(id:HarnessId,c:Selection)=>({id:selectHarnessModel(id,c.models,c.model),models:harnessModels(id,c.models),source:c.keySource,configurable:true,providerConfigurable:true,delivery:'native'});
  const resolve=(c:Connection)=>c.resolve(c.requested);
  function domesticAdapter(id:DomesticHarnessId):Adapter{
      const label=harnessDefinition(id)!.label;
      return {
        availability:(c:Selection)=>!input.domestic[id]?`${label} runtime is not configured`:!c.owner?'Sign in to use this harness':undefined,
        model:(c:Selection)=>providerModel(id,c),
        connect(c:Connection){
          const llm=resolve(c),runner=input.domestic[id];
          if(!runner||!llm?.apiBase||!llm.apiKey)throw failure('Harness or API connection is unavailable','harness_unavailable');
          const provider={apiBase:llm.apiBase,apiKey:llm.apiKey};
          llm.nativeInferenceConcurrency=runner.maxConcurrent;
          llm.chatCompletion=(request,options)=>runner.chatCompletion(request,{provider,timeoutMs:options?.timeoutMs,onProgress:step=>llm.onProgress?.(step)});
          return llm;
        },
      };
  }
  const adapters:Record<HarnessId,Adapter>={
    native:{availability:()=>undefined,model:c=>({id:c.model,source:c.keySource,configurable:true}),connect:resolve},
    codex:{
      availability:c=>!input.codex?'Codex relay is not configured':!c.owner?'Sign in to use Codex':!input.codex.allowsUser(c.owner)?'Codex is not enabled for this account':undefined,
      model:()=>input.codex?.view()??{id:null,configurable:false,providerConfigurable:false,reason:'Codex relay is not configured'},
      connect:c=>input.codex!.config(c.personalContext),
    },
    dsh:{
      availability:c=>!input.dsh&&!input.htmlConfigured()?'DSH service is not configured':!c.owner?'Sign in to use DeepSeek Harness':undefined,
      async model(c){
        if(input.dsh)return providerModel('dsh',c);
        try {const capability=await c.legacyCapabilities();return {id:selectHarnessModel('dsh',c.models,c.model)||capability.model,source:c.keySource,configurable:Boolean(capability.modelSelection),providerConfigurable:Boolean(capability.providerOverride),runnerDefault:capability.model};}
        catch{return {id:selectHarnessModel('dsh',c.models,c.model),configurable:false,reason:'DSH service is unavailable'};}
      },
      connect(c){
        const llm=resolve(c);
        if(!llm||c.appId?.startsWith('dsh_')||c.delivery==='html')return llm;
        const runner=input.dsh;
        if(!runner)throw failure('Native DSH inference transport is not configured','dsh_native_unavailable');
        const provider=llm.apiBase&&llm.apiKey?{apiBase:llm.apiBase,apiKey:llm.apiKey}:undefined;
        llm.nativeInferenceConcurrency=runner.maxConcurrent;
        llm.chatCompletion=(request,options)=>runner.chatCompletion(request,{timeoutMs:options?.timeoutMs??120000,roleLabel:options?.roleLabel,provider});
        return llm;
      },
    },
    qwen:domesticAdapter('qwen'),kimi:domesticAdapter('kimi'),zcode:domesticAdapter('zcode'),
  };
  function adapter(id:HarnessId){const result=adapters[id];if(!result)throw failure('Unknown harness','harness_unknown',400);return result;}
  return {
    choices(c:Selection):HarnessChoice[]{return harnessCatalog.filter(h=>!isDomesticHarness(h.id)||harnessModels(h.id,c.models).length>0).map(h=>{
      const reason=adapter(h.id).availability(c);
      return {id:h.id,label:h.label,available:!reason,...(reason?{reason}:{}),...(isDomesticHarness(h.id)?{description:`${h.label} · ${harnessModels(h.id,c.models).join(', ')}`}:{})};
    });},
    model(id:HarnessId,c:Selection){return adapter(id).model(c);},
    connect(id:HarnessId,context:Connection){
      const registered=adapter(id),definition=harnessDefinition(id)!;
      if(context.delivery==='html'&&!definition.htmlDelivery)throw failure(`${definition.label} uses Native app delivery`,id==='codex'?'codex_delivery_unsupported':'harness_delivery_unsupported',422);
      const reason=registered.availability(context);
      if(reason)throw failure(reason,id==='codex'?'codex_unavailable':'harness_unavailable');
      const c={...context,requested:{...context.requested},resolve(requested:Record<string,string>){
        const llm=context.resolve(requested);
        // Provider resolution can apply server defaults. Recheck the actual
        // selected model before any CLI receives it, including legacy DSH.
        if(llm&&definition.family&&!harnessModels(id,[String(llm.model)]).length)
          throw failure('Harness model route mismatch','harness_model_mismatch',409);
        return llm;
      }};
      if(definition.family){
        const model=selectHarnessModel(id,c.models,c.requested.model||c.model);
        if(!model)throw failure('No API model is configured for this app harness. Configure its model before running this app.','harness_model_unavailable',id==='dsh'?422:503);
        c.requested.model=model;
      }
      const llm=registered.connect(c);
      if(llm)llm.personalContext=c.personalContext;
      return llm;
    },
  };
}
