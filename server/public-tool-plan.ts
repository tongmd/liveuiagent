import { webToolRegistry, type WebToolSpec } from './web-tools.js';
import { remainingActionMs, actionDeadlineError, withActionDeadline, actionDeadlineAt } from './action-deadline.js';
type Obj = Record<string, any>;
const own = (v:any,k:string) => v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v,k);
function fail(message:string):never { throw Object.assign(new Error(`Public tool plan: ${message}`),{status:400}); }
function object(v:any):v is Obj { return !!v && typeof v==='object' && !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype; }
function pointerParts(pointer:any):string[] {
  if(typeof pointer!=='string' || pointer.length>500 || (pointer!==''&&!pointer.startsWith('/')) || /~(?![01])/u.test(pointer)) fail('invalid JSON pointer');
  const parts=pointer===''?[]:pointer.slice(1).split('/').map((p:string)=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(parts.some(p=>['__proto__','prototype','constructor'].includes(p))) fail('unsafe JSON pointer');
  return parts;
}
function read(v:any,pointer:string):any { for(const p of pointerParts(pointer)){ if(!own(v,p)) fail(`missing response pointer ${pointer}`); v=v[p]; } return v; }
function scalar(v:any):boolean { return typeof v==='string'&&v.length<=2000 || typeof v==='number'&&Number.isFinite(v) || typeof v==='boolean'; }
function text(v:any):string { return v===null?'unknown': typeof v==='object'?JSON.stringify(v):String(v); }
const argKeys:Record<string,string[]>={'tool.web.search':['query'],'tool.web.fetch':['url'],'tool.github.search':['query'],'tool.arxiv.search':['query'],'tool.weather.query':['location'],'tool.exchange.rate':['from','to','amount']};
export async function executePublicToolPlan(plan:any,payload:Obj,actionPermissions:string[],manifestPermissions:string[], registry:WebToolSpec[]=webToolRegistry) {
  return withActionDeadline(Date.now()+120000,()=>executeBoundedPublicToolPlan(plan,payload,actionPermissions,manifestPermissions,registry));
}
async function executeBoundedPublicToolPlan(plan:any,payload:Obj,actionPermissions:string[],manifestPermissions:string[],registry:WebToolSpec[]) {
  if(process.env.LIVEUIAGENT_APPWORLD_GROUNDING==='off')fail('external tools are disabled');
  if(!object(plan)||!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>6||!Array.isArray(plan.outputs)||plan.outputs.length<1||plan.outputs.length>6) fail('requires 1–6 steps and outputs');
  const seen=new Set<string>(); const specs=new Map<string,WebToolSpec>();
  for(const s of plan.steps){
    if(!object(s)||typeof s.id!=='string'||!/^[a-zA-Z][\w-]{0,39}$/.test(s.id)||seen.has(s.id)||typeof s.toolId!=='string'||(s.required!==undefined&&typeof s.required!=='boolean')||!object(s.args)) fail('invalid step');
    const tool=registry.find(t=>t.id===s.toolId);
    if(!tool||!argKeys[s.toolId]||!actionPermissions.includes(s.toolId)||!manifestPermissions.includes(s.toolId)) fail('tool is outside action/manifest permissions');
    const keys=Object.keys(s.args), allowed=argKeys[s.toolId];
    if(keys.some(k=>!allowed.includes(k))||allowed.filter(k=>k!=='amount').some(k=>!own(s.args,k))) fail('invalid tool arguments');
    const validateBinding=(binding:any):void=>{
      if(!object(binding)||Object.keys(binding).length!==1) fail('invalid argument binding');
      if(own(binding,'literal')) {if(!scalar(binding.literal)) fail('literal must be bounded scalar');}
      else if(own(binding,'field')) {if(typeof binding.field!=='string'||['__proto__','prototype','constructor','toolResults'].includes(binding.field)) fail('invalid UI field');}
      else if(own(binding,'response')) {if(!object(binding.response)||!seen.has(binding.response.step)) fail('response must reference an earlier step');pointerParts(binding.response.pointer);}
      else if(own(binding,'concat')) {if(!Array.isArray(binding.concat)||binding.concat.length<1||binding.concat.length>8)fail('invalid concat');for(const part of binding.concat){if(own(part,'concat'))fail('nested concat');validateBinding(part);}}
      else fail('unknown argument binding');
    };
    for(const binding of Object.values(s.args))validateBinding(binding);
    seen.add(s.id);specs.set(s.id,tool);
  }
  for(const o of plan.outputs){if(!object(o)||!seen.has(o.step)||typeof o.title!=='string'||!o.title.trim()||o.title.length>100||(o.detailPointers!==undefined&&!Array.isArray(o.detailPointers))||(!Array.isArray(o.detailPointers)&&!Array.isArray(o.detailFields))||(o.detailPointers?.length??0)>8||(o.detailFields?.length??0)>8) fail('invalid output'); for(const p of [o.itemsPointer,o.titlePointer,o.urlPointer,...(o.detailPointers??[]),...(o.detailFields??[]).map((f:any)=>f.pointer)].filter(p=>p!==undefined)) pointerParts(p);if(o.detailFields!==undefined&&(!Array.isArray(o.detailFields)||o.detailFields.some((f:any)=>!object(f)||typeof f.label!=='string'||!f.label.trim()||f.label.length>80||(f.suffix!==undefined&&(typeof f.suffix!=='string'||f.suffix.length>40)))))fail('invalid detail field');if(o.limitField!==undefined&&(typeof o.limitField!=='string'||!own(payload,o.limitField)||!/^([1-8])$/.test(String(payload[o.limitField]))))fail('output limit must be 1–8');}
  const receipts:Obj[]=[]; const responses=new Map<string,Obj>();
  for(const s of plan.steps){
    remainingActionMs(); const tool=specs.get(s.id)!;
    try {
      const args:Obj={};
      for(const [key,b] of Object.entries(s.args) as [string,any][]){
        const resolve=(b:any):any=>own(b,'literal')?b.literal:own(b,'field')?(own(payload,b.field)?payload[b.field]:fail(`missing UI field ${b.field}`)):own(b,'concat')?b.concat.map((part:any)=>{const v=resolve(part);if(!scalar(v))fail('invalid concat value');return String(v);}).join(''):read(responses.get(b.response.step),b.response.pointer);
        let value=resolve(b);
        if(key==='amount'&&typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))value=Number(value);
        if(!scalar(value)) fail('bound argument must be a bounded scalar');
        if(key==='amount' ? typeof value!=='number'||!Number.isFinite(value) : typeof value!=='string'||!value.trim()) fail(`invalid ${key} argument type`);
        args[key]=value;
      }
      let timer:ReturnType<typeof setTimeout>|undefined;
      const response=await Promise.race([tool.invoke(args),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(actionDeadlineError()),Math.min(remainingActionMs(),2147483647));})]).finally(()=>{if(timer)clearTimeout(timer);});
      remainingActionMs();
      if(!object(response)||typeof response.sourceUrl!=='string'||!/^https?:\/\//.test(response.sourceUrl)||typeof response.fetchedAt!=='string'||!Number.isFinite(Date.parse(response.fetchedAt))) fail('tool response lacks actual source/time');
      responses.set(s.id,response);
      receipts.push({step:s.id,api:tool.apiName,ok:true,request:args,response,requestSource:'web-tool-dispatched-arguments',phase:'public-tool-plan'});
    } catch(error){remainingActionMs();if(s.required!==false)throw error;receipts.push({step:s.id,api:tool.apiName,ok:false,error:String((error as Error).message),phase:'public-tool-plan'});}
  }
  if(!responses.size) fail('no public retrieval succeeded');
  const entities:Obj[]=[];
  for(const o of plan.outputs){const response=responses.get(o.step);if(!response)continue;
    const selected=o.itemsPointer===undefined?response:read(response,o.itemsPointer);const items=Array.isArray(selected)?selected.slice(0,o.limitField===undefined?8:Number(payload[o.limitField])):[selected];
    for(const [index,item] of items.entries()){
      const title=o.titlePointer===undefined?o.title:text(read(item,o.titlePointer));
      const url=o.urlPointer===undefined?response.sourceUrl:text(read(item,o.urlPointer));
      let parsed:URL;try{parsed=new URL(url);}catch{fail('invalid output URL');}if(!['https:','http:'].includes(parsed!.protocol)||parsed!.username||parsed!.password)fail('output URL must be HTTP without credentials');
      const details=[...(o.detailPointers??[]).map((p:string)=>`${p.split('/').filter(Boolean).at(-1)||'value'}: ${text(read(item,p))}`),...(o.detailFields??[]).map((f:any)=>{const v=read(item,f.pointer);if(v!==null&&!scalar(v)&&!(Array.isArray(v)&&v.every(scalar)))fail('display fields require primitive values');return `${f.label}: ${Array.isArray(v)?v.map(text).join(', '):text(v)}${f.suffix??''}`;})].join('\n');
      if(title.length>512||details.length>8192||url.length>2048)fail('output exceeds display bounds');
      entities.push({name:title,id:url,detail:`${o.title}\n${details}\nSource: ${response.sourceUrl}\nRetrieved: ${response.fetchedAt}`,status:'retrieved',publicToolPlanSource:{step:o.step,index,sourceUrl:response.sourceUrl,fetchedAt:response.fetchedAt}});
    }
  }
  if(entities.length>30||Buffer.byteLength(JSON.stringify(entities))>96*1024)fail('output exceeds total display bounds');
  for(const receipt of receipts) if(receipt.ok) receipt.publicPlanCards=entities.filter(e=>e.publicToolPlanSource.step===receipt.step);
  remainingActionMs();
  return {deadlineAt:actionDeadlineAt()!,receipts,entities,partial:receipts.some(r=>!r.ok),summary:receipts.map(r=>`${r.step}: ${r.ok?'retrieved':`unavailable (${r.error})`}`).join('\n')};
}

export function publicPlanCardFromRuntime(item:Obj,state:Obj):{name:string,id:string,detail:string}|null {
  const results=state.lastActionPayload?.toolResults;
  if(!object(results)||item.appRecordId!=null)return null;
  for(const receipt of Object.values(results) as Obj[]) {
    if(receipt?.ok!==true||receipt.phase!=='public-tool-plan'||receipt.requestSource!=='web-tool-dispatched-arguments'||!Array.isArray(receipt.publicPlanCards))continue;
    const card=receipt.publicPlanCards.find((c:Obj)=>c.name===item.name&&c.id===item.id);
    if(card&&typeof card.detail==='string')return {name:card.name,id:card.id,detail:card.detail};
  }
  return null;
}
