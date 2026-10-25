import {createHash} from 'node:crypto';
import {domainFieldUnion,type DomainField} from './native-domain-fields.js';

type RawField=Record<string,unknown>;
export type DomainDeclarationReference={inputIndex:number;persistedIndex:number;canonicalFieldName:string;rawTypedIdentitySha256:string};
const types=new Set(['string','text','select','boolean','date','number']);
function field(raw:unknown,input:boolean):RawField{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Domain reference requires an object declaration');
 const value=raw as RawField;
 const allowed=input?['label','type','required','placeholder','helpText','options']:['label','type','options'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('Domain reference declaration contains unknown or forbidden metadata');
 if(!Object.hasOwn(value,'label')||!Object.hasOwn(value,'type')||typeof value.label!=='string'||!value.label.trim()||typeof value.type!=='string'||!types.has(value.type))throw Error('Domain reference requires a complete literal label and explicit valid type');
 if(input&&(!Object.hasOwn(value,'required')||typeof value.required!=='boolean'))throw Error('Input declaration requires an explicit required boolean');
 for(const key of ['placeholder','helpText'])if(Object.hasOwn(value,key)&&typeof value[key]!=='string')throw Error('Invalid input declaration text');
 if(value.type==='select'){
  if(!Array.isArray(value.options)||!value.options.length)throw Error('Domain select requires explicit options');
  const seen=new Set<string>();
  for(const option of value.options){
   if(!option||typeof option!=='object'||Array.isArray(option)||Object.keys(option).some(key=>!['label','value'].includes(key))||typeof option.label!=='string'||!option.label.trim()||typeof option.value!=='string'||!option.value||option.value.length>40||seen.has(option.value))throw Error('Invalid or duplicate literal option declaration');
   seen.add(option.value);
  }
 }else if(Object.hasOwn(value,'options'))throw Error('Only select declarations may contain options');
 return value;
}
function typedIdentity(value:RawField){
 return {label:value.label,type:value.type,...(Object.hasOwn(value,'options')?{options:(value.options as Array<{label:string;value:string}>).map(option=>({label:option.label,value:option.value}))}:{})};
}
/** Resolve only redundant cross-array declarations, before any lossy display
 * normalization can be used as identity. Never infer values or write records.
 * normalized arrays MUST be the host's complete original-order normalization;
 * do not filter/reindex state declarations before calling this function. */
export function canonicalizeDomainReferences(rawSlots:unknown,rawStates:unknown,normalizedSlots:readonly DomainField[],normalizedStates:readonly DomainField[]){
 if(!Array.isArray(rawSlots)||rawSlots.length<1||rawSlots.length>6||!Array.isArray(rawStates)||rawStates.length>12||normalizedSlots.length!==rawSlots.length||normalizedStates.length!==rawStates.length)throw Error('Domain reference cardinality or normalization mapping mismatch');
 const slots=rawSlots.map(raw=>field(raw,true));
 const states=rawStates.map(raw=>field(raw,false));
 domainFieldUnion(normalizedSlots,[]);// Never bypass the existing input gate.
 const inputNames=new Map(normalizedSlots.map((value,index)=>[value.name,index]));
 const stateNames=new Set<string>();const additional:DomainField[]=[];const additionalIndices:number[]=[];const references:DomainDeclarationReference[]=[];
 for(let index=0;index<states.length;index++){
  const normalized=normalizedStates[index];
  domainFieldUnion([],[normalized]);// A reference cannot bypass state namespace/metadata gates.
  if(stateNames.has(normalized.name))throw Error('Duplicate declarations inside persistedDomainFields');
  stateNames.add(normalized.name);
  if(normalized.type!==states[index].type)throw Error('State normalization changed the explicit type');
  const inputIndex=inputNames.get(normalized.name);
  if(inputIndex===undefined){additional.push(structuredClone(normalized));additionalIndices.push(index);continue;}
  const input=normalizedSlots[inputIndex];
  const original=JSON.stringify(typedIdentity(slots[inputIndex]));
  const repeated=JSON.stringify(typedIdentity(states[index]));
  if(input.type!==slots[inputIndex].type||input.type!==normalized.type||original!==repeated||JSON.stringify(input.options?.map(option=>[option.label,option.value]))!==JSON.stringify(normalized.options?.map(option=>[option.label,option.value])))throw Error('Cross-array collision is not an exact complete raw typed reference');
  references.push({inputIndex,persistedIndex:index,canonicalFieldName:input.name,rawTypedIdentitySha256:createHash('sha256').update(original).digest('hex')});
 }
 const union=domainFieldUnion(normalizedSlots,additional);
 return {persistedDomainFields:additional,additionalStateIndices:additionalIndices,schemaFields:union,aliasTrace:{schemaVersion:1 as const,rule:'exact-raw-cross-array-reference' as const,references},
  // Private diagnostics only; never attach original model text to public UI.
  rawDeclarations:{slots:structuredClone(rawSlots),persistedDomainFields:structuredClone(rawStates)}};
}
