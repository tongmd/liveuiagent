import {stateDisplayFields} from './native-state-display.js';
/** Input controls and persistent business state are distinct typed contracts.
 * This helper never turns workflow state, a field label or a value into schema. */
export type DomainField={name:string;label:string;type:'string'|'text'|'select'|'boolean'|'date'|'number';options?:Array<{label:string;value:string}>;required?:boolean;hiddenInForm?:boolean};
export const persistedDomainPolicy='Business input fields are composer controls AND already belong to the declared persistent record schema; do not repeat any input slot in persistedDomainFields. persistedDomainFields contains only ADDITIONAL state absent from slots/businessFields, never a second copy of the complete data model. Do not repeat any normalized field name or label across the two arrays or within either array. persistedDomainFields declares only domain state explicitly required by the original app need to survive reopening or change through a requested action. Workflow state/nextStep/result are not domain state. These declared values are not extra form inputs, not action consumed slots, not default facts and never proof that an external service changed. Use the same exact declared schema for owner/app SQLite writes and real subsequent reads; unknown/null remains Not set. Derive persisted values only from the explicit current action/original need or actual read-back; absent values remain null/Not set, never default facts. A requested status annotation does not authorize the external transaction behind that status. Perform an external change only when the user actually requested it, using the authorized external API and fresh read-back; never substitute an unrelated transaction for a missing declared domain field. Never create undeclared fields, invent initial values, or replace external service obligations with local state.';
export function domainFieldUnion(inputs:readonly DomainField[],persisted:readonly DomainField[]=[]):DomainField[]{
 if(!Array.isArray(inputs)||inputs.length>6||!Array.isArray(persisted)||persisted.length>12)throw Error('Domain schema requires at most 6 input and 12 persisted state fields');
 const names=new Map<string,string>();
 const labels=new Map<string,string>();
 for(const [index,field] of [...inputs,...persisted].entries()){
  const location=index<inputs.length?`slots[${index}]`:`persistedDomainFields[${index-inputs.length}]`;
  if(!field||typeof field.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name))throw Error(`Invalid domain field name at ${location}`);
  const label=typeof field.label==='string'?field.label.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase():'';
  const conflict=names.has(field.name)?{kind:'name',value:field.name,prior:names.get(field.name)}:label&&labels.has(label)?{kind:'normalized label',value:label,prior:labels.get(label)}:null;
  if(conflict)throw Error(`Domain field collision: ${location} ${conflict.kind} ${JSON.stringify(conflict.value)} conflicts with ${conflict.prior}. Input slots already belong to the persistent schema; persistedDomainFields must contain only additional state, without duplicating either namespace.`);
  if(index>=inputs.length&&Object.keys(field).some(key=>!['name','label','type','options'].includes(key)))throw Error('Persistent domain metadata accepts only name/label/type/options');
  if(index>=inputs.length&&stateDisplayFields([field]).length!==1)throw Error('Persistent domain field is outside the declared display namespace');
  if(index>=inputs.length&&(typeof field.label!=='string'||!field.label.trim()||!['string','text','select','boolean','date','number'].includes(field.type)))throw Error('Invalid declared domain field');
  if(field.hiddenInForm||index>=inputs.length&&['hiddenInForm','required','default'].some(key=>Object.hasOwn(field,key)))throw Error('Domain state cannot use form/workflow/default semantics');
  if(index>=inputs.length&&field.type!=='select'&&field.options!==undefined)throw Error('Only persisted select state may declare options');
  if(index>=inputs.length&&field.options?.some((option:{label:string;value:string})=>!option||typeof option.label!=='string'||typeof option.value!=='string'||!option.value||option.value.length>40))throw Error('Invalid persisted domain options');
  if(field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||new Set(field.options.map((o:{value:string})=>o.value)).size!==field.options.length))throw Error('Domain select requires distinct declared options');
  names.set(field.name,`${location} name ${JSON.stringify(field.name)}`);
  if(label)labels.set(label,`${location} label ${JSON.stringify(field.label)}`);
 }
 return [...inputs,...persisted];
}
