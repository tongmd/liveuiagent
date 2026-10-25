import path from 'node:path';
import {writePrivateDiagnostics,type PrivateDiagnosticsReceipt} from './grounding-diagnostics.js';
import {validateInteractionInput,resolveControlPreparation,type InteractionStep} from './gui-interaction-planner.js';
function step(value:InteractionStep){return Object.fromEntries(['kind','target','value','checked'].filter(key=>(value as any)[key]!==undefined).map(key=>[key,(value as any)[key]]));}
function unknownKeys(raw:any){const keys:string[]=[];const inspect=(value:any,allowed:string[])=>{if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of Object.keys(value))if(!allowed.includes(key))keys.push(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)?key:'[invalid key]');};inspect(raw,['operation','fields','action']);inspect(raw?.operation,['quote','target','rowContextQuote']);if(Array.isArray(raw?.fields))for(const field of raw.fields)inspect(field,['target','decision','binding','value','checked','source','quote']);inspect(raw?.action,['kind','target','value','checked','reason']);return[...new Set(keys)].slice(0,100);}
/** Never logs a model's free-form reasoning, unknown values, provider settings or
 * an unvalidated preparation. No diagnostics IO can alter planning/execution. */
export function writeGuiPlanningDiagnostics(input:unknown,preparation:any,resolved?:InteractionStep,error?:unknown):PrivateDiagnosticsReceipt|undefined{
 const root=process.env.LIVEUIAGENT_GUI_DIAGNOSTICS_ROOT;if(!root)return undefined;
 try{
  const directory=path.join(root,'gui-planning-diagnostics');
  if(error)return writePrivateDiagnostics(directory,{role:'Native GUI Step Planner',status:'invalid_contract',code:'invalid_gui_interaction',unknownKeys:unknownKeys(preparation)},'Private GUI planning validation error; only safe code and key names, never unknown values. No execution or replay authorized.');
  if(!resolved)throw Error('Validated resolved step required');
  const checked=resolveControlPreparation(preparation,input);if(JSON.stringify(checked)!==JSON.stringify(resolved))throw Error('Resolved step does not match validated preparation');
  const raw=input as any;
  const context=validateInteractionInput({appId:'diagnostic',harness:'native',model:'diagnostic',userMessage:raw.userMessage,snapshot:raw.snapshot,observations:raw.observations??[]});
  const fields=preparation.fields.map((field:any)=>Object.fromEntries(['target','decision','binding','value','checked','source','quote'].filter(key=>field[key]!==undefined).map(key=>[key,field[key]])));
  return writePrivateDiagnostics(directory,{role:'Native GUI Step Planner',status:'validated',currentMessage:context.userMessage,snapshot:context.snapshot,observations:context.observations.map(observation=>({...observation,step:step(observation.step)})),preparation:{operation:Object.fromEntries(['quote','target','rowContextQuote'].filter(key=>preparation.operation[key]!==undefined).map(key=>[key,preparation.operation[key]])),fields,action:step(preparation.action)},resolvedStep:step(resolved),reasonPolicy:'Free-form action/step reasons and chain-of-thought are not recorded; source quotes are untrusted task data.'},'Private validated GUI planning contract audit, not business evidence or permission to replay. Defaults off; no provider configuration or free-form model reasoning.');
 }catch{return{status:'not_written',reason:'diagnostics_unavailable'};}
}
