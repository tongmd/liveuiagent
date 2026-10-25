import {stateDisplayFields} from './native-state-display.js';
/** Input controls and persistent business state are distinct typed contracts.
 * This helper never turns workflow state, a field label or a value into schema. */
export type DomainField={name:string;label:string;type:'string'|'text'|'select'|'boolean'|'date'|'number';options?:Array<{label:string;value:string}>;required?:boolean;hiddenInForm?:boolean};
export const persistedDomainPolicy='Business input fields are composer controls, not the complete persistent business model. persistedDomainFields declares only domain state explicitly required by the original app need to survive reopening or change through a requested action. Workflow state/nextStep/result are not domain state. These declared values are not extra form inputs, not action consumed slots, not default facts and never proof that an external service changed. Use the same exact declared schema for owner/app SQLite writes and real subsequent reads; unknown/null remains Not set. Derive persisted values only from the explicit current action/original need or actual read-back; absent values remain null/Not set, never default facts. A requested status annotation does not authorize the external transaction behind that status. Perform an external change only when the user actually requested it, using the authorized external API and fresh read-back; never substitute an unrelated transaction for a missing declared domain field. Never create undeclared fields, invent initial values, or replace external service obligations with local state.';
export function domainFieldUnion(inputs:readonly DomainField[],persisted:readonly DomainField[]=[]):DomainField[]{
 if(!Array.isArray(inputs)||inputs.length>6||!Array.isArray(persisted)||persisted.length>12)throw Error('Domain schema requires at most 6 input and 12 persisted state fields');
 const names=new Set<string>();
 for(const [index,field] of [...inputs,...persisted].entries()){
  if(!field||typeof field.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)||names.has(field.name))throw Error('Invalid or conflicting domain field name');
  if(index>=inputs.length&&Object.keys(field).some(key=>!['name','label','type','options'].includes(key)))throw Error('Persistent domain metadata accepts only name/label/type/options');
  if(index>=inputs.length&&stateDisplayFields([field]).length!==1)throw Error('Persistent domain field is outside the declared display namespace');
  if(index>=inputs.length&&(typeof field.label!=='string'||!field.label.trim()||!['string','text','select','boolean','date','number'].includes(field.type)))throw Error('Invalid declared domain field');
  if(field.hiddenInForm||index>=inputs.length&&['hiddenInForm','required','default'].some(key=>Object.hasOwn(field,key)))throw Error('Domain state cannot use form/workflow/default semantics');
  if(index>=inputs.length&&field.type!=='select'&&field.options!==undefined)throw Error('Only persisted select state may declare options');
  if(index>=inputs.length&&field.options?.some((option:{label:string;value:string})=>!option||typeof option.label!=='string'||typeof option.value!=='string'||!option.value||option.value.length>40))throw Error('Invalid persisted domain options');
  if(field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||new Set(field.options.map((o:{value:string})=>o.value)).size!==field.options.length))throw Error('Domain select requires distinct declared options');
  names.add(field.name);
 }
 return [...inputs,...persisted];
}
