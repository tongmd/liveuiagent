import path from 'node:path';
import {createHash} from 'node:crypto';
import {writePrivateDiagnostics,type PrivateDiagnosticsReceipt} from './grounding-diagnostics.js';
import {terminalPreparationNormalization,canonicalGuiMessageBinding,validateInteractionInput,resolveControlPreparation,type InteractionStep} from './gui-interaction-planner.js';
function step(value:InteractionStep){return Object.fromEntries(['kind','target','value','checked','quote'].filter(key=>(value as any)[key]!==undefined).map(key=>[key,(value as any)[key]]));}
function unknownKeys(raw:any){const keys:string[]=[];const inspect=(value:any,allowed:string[])=>{if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of Object.keys(value))if(!allowed.includes(key))keys.push(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)?key:'[invalid key]');};inspect(raw,['operation','fields','action']);inspect(raw?.operation,['rowContextQuote']);if(Array.isArray(raw?.fields))for(const field of raw.fields)inspect(field,['target','decision','binding','value','checked','source','quote']);inspect(raw?.action,['kind','target','value','checked','quote','reason']);return[...new Set(keys)].slice(0,100);}
// Rejected preparations are untrusted data. Preserve only structured
// contract fields, never free-form reasons or unknown values (including CoT).
function rejectedStructure(raw:any){
 const pick=(value:any,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value))return{invalidType:typeof value};return Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>{const v=value[k];return[k,typeof v==='string'?v:typeof v==='boolean'||typeof v==='number'||v===null?v:{invalidType:Array.isArray(v)?'array':typeof v}];}));};
 return {operation:pick(raw?.operation,['rowContextQuote']),fields:Array.isArray(raw?.fields)?raw.fields.map((v:any)=>pick(v,['target','decision','binding','value','checked','source','quote'])):{invalidType:typeof raw?.fields},action:pick(raw?.action,['kind','target','value','checked','quote'])};
}
function diagnosticContext(input:any){return validateInteractionInput({appId:'diagnostic',harness:'native',model:'diagnostic',userMessage:input.userMessage,snapshot:input.snapshot,observations:input.observations??[]});}
function sourceHashes(input:any,preparation:any){const hash=(value:any)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');return{currentMessage:hash(input.userMessage),snapshot:hash(input.snapshot),preparation:hash(preparation)};}
/** Never logs a model's free-form reasoning, unknown values, provider settings or
 * unknown preparation fields. No diagnostics IO can alter planning/execution. */
export function writeGuiPlanningDiagnostics(input:unknown,preparation:any,resolved?:InteractionStep,error?:unknown):PrivateDiagnosticsReceipt|undefined{
 const root=process.env.LIVEUIAGENT_GUI_DIAGNOSTICS_ROOT;if(!root)return undefined;
 try{
  const directory=path.join(root,'gui-planning-diagnostics');const binding=canonicalGuiMessageBinding(input);const sourceBinding={source:binding.source,sha256:binding.sha256};
  if(error){const context=diagnosticContext(input);return writePrivateDiagnostics(directory,{role:'Native GUI Step Planner',status:'invalid_contract',code:'invalid_gui_interaction',unknownKeys:unknownKeys(preparation),currentMessage:context.userMessage,sourceBinding,snapshot:context.snapshot,observations:context.observations.map(observation=>({...observation,step:step(observation.step)})),preparation:rejectedStructure(preparation),sourceHashes:sourceHashes(input,preparation)},'Private rejected structured GUI proposal and actual input; unvalidated data, never business evidence or replay permission. Unknown values and free-form reasons are excluded.');}
  if(!resolved)throw Error('Validated resolved step required');
  const checked=resolveControlPreparation(preparation,input);if(JSON.stringify(checked)!==JSON.stringify(resolved))throw Error('Resolved step does not match validated preparation');
  const raw=input as any;
  const context=validateInteractionInput({appId:'diagnostic',harness:'native',model:'diagnostic',userMessage:raw.userMessage,snapshot:raw.snapshot,observations:raw.observations??[]});
  const terminalNormalization=terminalPreparationNormalization(preparation,input);
  const fields=preparation.fields.map((field:any)=>Object.fromEntries(['target','decision','binding','value','checked','source','quote'].filter(key=>field[key]!==undefined).map(key=>[key,field[key]])));
  return writePrivateDiagnostics(directory,{role:'Native GUI Step Planner',status:'validated',currentMessage:context.userMessage,sourceBinding,snapshot:context.snapshot,observations:context.observations.map(observation=>({...observation,step:step(observation.step)})),...(terminalNormalization?{terminalNormalization,unexecutedTerminalProposal:{operation:Object.fromEntries(['rowContextQuote'].filter(key=>preparation.operation[key]!==undefined).map(key=>[key,preparation.operation[key]])),fields,action:step(preparation.action)}}:{}),preparation:{operation:terminalNormalization?{}:Object.fromEntries(['rowContextQuote'].filter(key=>preparation.operation[key]!==undefined).map(key=>[key,preparation.operation[key]])),fields:terminalNormalization?[]:fields,action:step(preparation.action)},resolvedStep:step(resolved),reasonPolicy:'Free-form action/step reasons and chain-of-thought are not recorded; source quotes are untrusted task data.'},'Private validated GUI planning contract audit, not business evidence or permission to replay. Defaults off; no provider configuration or free-form model reasoning.');
 }catch{return{status:'not_written',reason:'diagnostics_unavailable'};}
}
