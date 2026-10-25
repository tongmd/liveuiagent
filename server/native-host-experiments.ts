import path from 'node:path';
import type {LlmRuntimeConfig} from './liveuiagent.js';
export type NativeHostExperiments=Readonly<{businessThinking:'off'|'enabled-low';innerWorkerPlanning:'labelled-reference'|'record-only';captureInputs:boolean}>;
/** Process-owned bench configuration only. Never parse request/manifest/user settings here. */
export function readNativeHostExperiments(env:Record<string,string|undefined>):NativeHostExperiments{
 const defaults:NativeHostExperiments={businessThinking:'off',innerWorkerPlanning:'labelled-reference',captureInputs:false};
 const raw=env.LIVEUI_NATIVE_DSH_EXPERIMENTS;if(raw===undefined)return Object.freeze(defaults);
 let value:any;try{value=JSON.parse(raw);}catch{throw Error('LIVEUI_NATIVE_DSH_EXPERIMENTS must be a JSON object');}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaults,k)))throw Error('Invalid Native host experiment keys');
 const result={...defaults,...value};
 if(!['off','enabled-low'].includes(result.businessThinking)||!['labelled-reference','record-only'].includes(result.innerWorkerPlanning)||typeof result.captureInputs!=='boolean')throw Error('Invalid Native host experiment value');
 if((result.businessThinking!=='off'||result.innerWorkerPlanning!=='labelled-reference'||result.captureInputs)&&(!/^[-a-zA-Z0-9_.]{1,160}$/.test(env.LIVEUIBENCH_RUN_ID||'')||!env.LIVEUI_NATIVE_DSH_COMMAND?.trim()))throw Error('Native experiments require explicit bench run and Native command');
 return Object.freeze(result);
}
export function nativeHostCaptureRoot(taskRoot:string,config:NativeHostExperiments){return config.captureInputs?path.join(path.dirname(path.resolve(taskRoot)),'native-inference-inputs'):undefined;}
/** Apply only after the actual server Native DSH adapter was selected. */
export function bindNativeHostExperiments(llm:LlmRuntimeConfig,config:NativeHostExperiments):LlmRuntimeConfig{
 const bound={...llm};delete bound.experimentalNativeBusinessThinking;
 if(config.businessThinking==='enabled-low')bound.experimentalNativeBusinessThinking='enabled-low';
 return bound;
}
