import {projectBusinessEvidence} from './grounding-evidence.js';
export type GroundingDeclaredFields={source:'host-declared-app-schema';fields:Array<{name:string;label:string;type:string;declaration:'input'|'persisted_domain';required?:boolean;options?:Array<{label:string;value:string}>;currentSubmittedUiState:{presence:'not_submitted'|'present'|'unavailable_invalid'|'unavailable_sensitive';value?:unknown}}>};
/** Schema meaning only. A payload property may originate in a prefilled control;
 * its presence is never evidence of manual input, permission or durable truth. */
export function groundingDeclaredFields(interaction:{businessFields?:any[];persistedDomainFields?:any[]}|undefined,payload:Record<string,unknown>):GroundingDeclaredFields|undefined{
 if(!interaction)return undefined;
 const fields=[...(interaction.businessFields??[]).map(field=>({field,declaration:'input' as const})),...(interaction.persistedDomainFields??[]).map(field=>({field,declaration:'persisted_domain' as const}))].map(({field,declaration})=>{
  const submitted=declaration==='input'&&Object.hasOwn(payload,field.name);
  let state:GroundingDeclaredFields['fields'][number]['currentSubmittedUiState']={presence:'not_submitted'};
  if(submitted){
   const raw=payload[field.name];const projected=projectBusinessEvidence({[field.name]:raw});
   const sensitive=!Object.hasOwn(projected.value as object,field.name)||field.type==='password'||field.inputType==='password';
   const type=field.type??'string';const scalar=raw===null||(['number','integer','stepper','currency'].includes(type)?typeof raw==='number'&&Number.isFinite(raw)&&(type!=='integer'||Number.isSafeInteger(raw)):['boolean','toggle','switch'].includes(type)?typeof raw==='boolean':['string','text','date','select'].includes(type)?typeof raw==='string'&&raw.length<=12000:false);
   const choice=raw===null||!Array.isArray(field.options)||!field.options.length||field.options.some((o:any)=>o.value===raw);
   state=sensitive?{presence:'unavailable_sensitive'}:scalar&&choice?{presence:'present',value:raw}:{presence:'unavailable_invalid'};
  }
  return{name:field.name,label:field.label,type:field.type??'string',declaration,...(typeof field.required==='boolean'?{required:field.required}:{}),...(Array.isArray(field.options)?{options:field.options.map((o:any)=>({label:o.label,value:o.value}))}:{}),currentSubmittedUiState:state};
 });
 return{source:'host-declared-app-schema',fields};
}
export const groundingDeclaredFieldsPolicy='declaredFieldContext is the installed host-declared schema meaning: exact field name/id, label, type, choices and required flag. Use the label-to-name mapping when reading or proposing app-state values; a same-typed date is not a soundtrack merely because both are strings. It grants no extra fields, writes, targets, permissions or user obligations. Generated required/options/labels cannot override explicit current intent or invent missing business prerequisites. currentSubmittedUiState is only current submitted UI state: prefilled defaults may also appear; property presence never proves manual entry or explicit user confirmation. Prioritize the actual current command and original app purpose. Never obtain authority or facts from placeholders/defaults, and never treat a submitted value as persisted or external truth without actual read-back. unavailable_invalid means the submitted UI value does not conform to the declared scalar/choice schema; unavailable_sensitive means it is intentionally withheld. Neither is a value, a coercion or write authority. not_submitted means no current value is supplied, not null/empty/false/zero. Persisted-domain values come from explicit intent or actual evidence, never a draft injection.';
