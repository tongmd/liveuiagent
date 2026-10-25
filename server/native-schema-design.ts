import type {AppWorldToolCapability} from './appworld-bridge.js';
const credential = /(?:^|_)(?:authorization|authentication|verification_code|access_token|refresh_token|token|password|secret|api_key|cookie)(?:$|_)/i;
const isCredential=(name:string)=>credential.test(name.replace(/([a-z])([A-Z])/g,'$1_$2').replace(/[^A-Za-z0-9_]/g,'_'));
const scalarKeys = new Set(['type','title','description','format','pattern','nullable','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','uniqueItems']);
// Public API contract only: never copy capability extensions, auth values,
// responses, bridge identity/config, examples or arbitrary default strings.
export function schemaDesignCatalog(capabilities:AppWorldToolCapability[],services:string[]) {
  let nodes=0;
  const schema=(raw:any,depth=0):any=>{
    if(++nodes>20000||depth>12)throw Error('Schema design catalog exceeds structural bound');
    if(typeof raw==='boolean')return raw;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Schema design requires an object request schema');
    if(Object.hasOwn(raw,'$ref'))throw Error('Schema design requires resolved public request schemas');
    const out:Record<string,unknown>={};
    for(const [key,value]of Object.entries(raw)){
      if(scalarKeys.has(key)){
        if(typeof value==='string'&&value.length<=4000||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||key==='type'&&Array.isArray(value)&&value.every(v=>typeof v==='string'))out[key]=value;
        else throw Error('Invalid public schema scalar');
      }else if(key==='properties'){
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid public schema properties');
        out.properties=Object.fromEntries(Object.entries(value).filter(([name])=>!isCredential(name)).map(([name,child])=>[name,schema(child,depth+1)]));
      }else if(key==='required'){
        if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error('Invalid public schema required');
        out.required=value.filter(name=>!isCredential(name));
      }else if(key==='items'||key==='additionalProperties')out[key]=schema(value,depth+1);
      else if(['anyOf','oneOf','allOf'].includes(key)){
        if(!Array.isArray(value))throw Error('Invalid public schema alternatives');
        out[key]=value.map(child=>schema(child,depth+1));
      }else if(key==='default'&&(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)))out.default=value;
      else if(key==='enum'){
        if(!Array.isArray(value)||value.some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)))throw Error('Invalid public schema enum');
        out.enum=value;
      }
    }
    return out;
  };
  const selected=capabilities.filter(tool=>tool.source==='appworld'&&services.includes(tool.appName));
  if(selected.length>512)throw Error('Schema design catalog exceeds capability bound');
  for(const service of services)if(!selected.some(tool=>tool.appName===service))throw Error('Selected service has no public design capabilities');
  const result=selected.map(tool=>({service:tool.appName,api:tool.apiName,method:tool.method,purpose:tool.purpose,requestSchema:schema(tool.inputSchema)}));
  if(Buffer.byteLength(JSON.stringify(result))>200000)throw Error('Schema design catalog exceeds byte bound');
  return result;
}
function keys(value:any,allowed:string[],where:string){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw Error(`Invalid schema design ${where}: only declared output fields are accepted`);
}
// This is only an output-shape gate. Existing Business Slot normalization owns
// cardinality, labels, options, collisions, required flags and consumed indices.
export function validateSchemaDesignRefinement(raw:any){
 keys(raw,['slots','actions'],'refinement');
 if(!Array.isArray(raw.slots)||!Array.isArray(raw.actions))throw Error('Schema design requires explicit slots and actions');
 for(const slot of raw.slots){
  keys(slot,['label','type','required','placeholder','helpText','options'],'slot');
  if(!['string','text','select','boolean','date','number'].includes(slot.type))throw Error('Schema design slot must have an explicit valid type');
  if(slot.options!==undefined){if(!Array.isArray(slot.options))throw Error('Invalid schema design options');for(const option of slot.options)keys(option,['label','value'],'option');}
 }
 for(const action of raw.actions){
  keys(action,['label','description','perItem','consumedSlotIndices'],'action');
  if(action.perItem!==undefined&&typeof action.perItem!=='boolean')throw Error('Schema design perItem must be boolean');
  if(action.perItem!==true&&action.consumedSlotIndices!==undefined)throw Error('Non-item schema design action cannot declare consumed indices');
 }
}
