import {createHash} from 'node:crypto';
import {businessSurfaceWithoutHostCommand,hostCommandComponents} from './native-host-command.js';
/** Existing visible-GUI/Native transport limits; a view pass is not a promise
 * that a later inference including arbitrary history fits its whole packet. */
export const NATIVE_VIEW_LIMITS={fields:100,buttons:100,textUnits:50000,encodedBytes:2*1024*1024} as const;
const fail=(message:string):never=>{throw Error('projection_capacity: '+message);};
export function nativeViewBudget(surface:any,hostDescriptor?:unknown){
 if(!surface||!Array.isArray(surface.messages)||!surface.initialData)fail('unknown Native surface/data contract');
 if(hostDescriptor!==undefined)businessSurfaceWithoutHostCommand(surface,hostDescriptor);// exact host-block proof, not model metadata
 const updates=surface.messages.filter((m:any)=>m?.updateComponents);if(updates.length!==1||!Array.isArray(updates[0].updateComponents.components))fail('one complete component update required');
 const nodes:any[]=updates[0].updateComponents.components;const byId=new Map(nodes.map(n=>[n.id,n]));if(byId.size!==nodes.length)fail('duplicate component IDs');
 const supported=new Set(['Card','Column','Row','Text','Badge','SectionHeading','StatBlock','StatGrid','TextField','Button','List']);
 if(nodes.some(n=>!supported.has(n.component))||nodes.filter(n=>n.component==='List').length!==1)fail('unknown complete-view graph/template contract');
 const root=surface.messages.find((m:any)=>m?.beginRendering)?.beginRendering?.root??'root';
 const data=surface.initialData;const resolve=(v:any,row:any)=>{if(v&&typeof v==='object'&&!Array.isArray(v)){if(typeof v.path!=='string')fail('unknown value binding');const absolute=v.path.startsWith('/');let value=absolute?data:row;for(const part of v.path.split('/').filter(Boolean))value=value?.[part];if(value===undefined||value===null)fail('unresolved visible binding '+v.path);return value;}return v;};
 // innerText may apply renderer CSS uppercase; preserve raw state and bound
 // both Unicode expansion and UTF8 encoding without changing business values.
 const variants=(text:string)=>[text,text.toUpperCase(),text.toLowerCase()];
 const byteText=(text:string)=>variants(text).reduce((a,b)=>Buffer.byteLength(JSON.stringify(a))>=Buffer.byteLength(JSON.stringify(b))?a:b);
 const unitText=(parts:string[],count:number)=>parts.reduce((sum,text)=>sum+Math.max(...variants(text).map(v=>v.length)),0)+2*(parts.length+count);
 const boundText=(parts:string[],count:number)=>parts.map(byteText).join('\n\n')+'\n\n'.repeat(count);
 const scalar=(v:any,row:any)=>{const value=resolve(v,row);if(!['string','number','boolean'].includes(typeof value))fail('visible scalar required');return String(value);};
 type Button={label:string;actionId:string;row?:number};
 const fields:any[]=[];const buttons:Button[]=[];const rowTexts:string[]=[];let visits=0;let rowButtons=0,globalButtons=0,lists=0;
 const active=new Set<string>();
 function walk(id:string,row:any=data,rowIndex?:number):{parts:string[];count:number}{
  if(active.has(id))fail('cyclic component graph');const n=byId.get(id);if(!n)fail('dangling component '+id);active.add(id);if(++visits*2>NATIVE_VIEW_LIMITS.textUnits)fail('expanded whitespace/text bound exceeds50000 units');
  const parts:string[]=[];let count=1;const text=(v:any)=>{if(v!==undefined)parts.push(scalar(v,row));};const child=(key:string)=>{const result=walk(key,row,rowIndex);parts.push(...result.parts);count+=result.count;};
  switch(n.component){
   case 'Card':child(n.child);break;
   case 'Column':case 'Row':if(!Array.isArray(n.children))fail('container children required');n.children.forEach(child);break;
   case 'Text':case 'Badge':text(n.text);break;
   case 'SectionHeading':text(n.title);text(n.kicker);text(n.meta);break;
   case 'StatBlock':text(n.label);text(n.value);text(n.caption);break;
   case 'StatGrid':{const stats=resolve({path:n.path},row);if(!Array.isArray(stats))fail('stats array required');for(const stat of stats){text(stat.label);text(stat.value);}break;}
   case 'TextField':{
    if(rowIndex!==undefined)fail('row input budget is unsupported');
    const value=scalar(n.value,row);const label=scalar(n.label,row);const options=Array.isArray(n.options)?n.options.map((o:any)=>({label:scalar(o.label,row),value:scalar(o.value,row),disabled:false})):undefined;
    if(value.length>8000||label.length>500||(options?.length??0)>300||options?.some((o:any)=>o.label.length>1000||o.value.length>1000))fail('field exceeds visible snapshot string/options bounds');
    const choice=n.variant==='choice';const wireOptions=choice?options?.map((o:any)=>({...o,label:byteText(o.label),value:byteText(o.label)})):options;const wireValue=choice?(options?.find((o:any)=>o.value===value.trim()||o.label===value.trim())?.label??''):value;
    if(wireOptions?.some((o:any)=>o.label.length>1000||o.value.length>1000))fail('rendered option text may exceed snapshot bound');
    fields.push({target:'e'+'9'.repeat(99),label,type:String(n.variant??'shortText'),value:wireValue,...(wireOptions?{options:wireOptions}:{})});text(n.label);text(n.value);for(const option of options??[])parts.push(option.label);break;
   }
   case 'Button':{const before=parts.length;child(n.child);const actionId=n.action?.event?.name;if(typeof actionId!=='string')fail('bound action required');if(parts.slice(before).join('\n\n').length>500||actionId.length>200)fail('button exceeds visible snapshot bounds');buttons.push({label:parts.slice(before).join('\n\n'),actionId,...(rowIndex!==undefined?{row:rowIndex}:{})});if(rowIndex===undefined)globalButtons++;else rowButtons++;break;}
   case 'List':{
    if(n.children?.path!=='/entities'||rowIndex!==undefined)fail('only one full primary entity list is supported');lists++;const rows=resolve({path:'/entities'},row);if(!Array.isArray(rows))fail('complete entities array required');
    for(let i=0;i<rows.length;i++){const result=walk(n.children.componentId,rows[i],i);rowTexts[i]=boundText(result.parts,result.count);if(unitText(result.parts,result.count)>50000)fail('row text exceeds50000 UTF16 units');parts.push(...result.parts);count+=result.count;}
    break;
   }
   default:fail('unsupported visible component '+n.component);
  }
  active.delete(id);if(fields.length>100||buttons.length>100)fail('actual visible controls exceed100 fields or100 buttons');return{parts,count};
 }
 const expansion=walk(root);if(lists!==1)fail('exactly one complete primary list required');
 const hasHost=hostDescriptor!==undefined;const hostNodes=hostCommandComponents();const reserved={fields:hasHost?0:hostNodes.filter(n=>n.component==='TextField').length,buttons:hasHost?0:hostNodes.filter(n=>n.component==='Button').length};
 if(fields.length+reserved.fields>100||buttons.length+reserved.buttons>100)fail('controls plus absent host-command reservation exceed100');
 const visibleText=boundText(expansion.parts,expansion.count);
 const visibleTextUpperBound=unitText(expansion.parts,expansion.count);
 if(visibleTextUpperBound>50000||rowTexts.some(text=>text.length>50000))fail('expanded visible text exceeds50000 UTF16 units');
 // Padding covers optional DOM flags, browser IDs and container whitespace.
 const snapshot={visibleText,fields:fields.map(f=>({...f,tag:'textarea',required:false,disabled:false,readOnly:false,checked:false})),buttons:buttons.map(b=>({target:'e'+'9'.repeat(99),label:b.label,actionId:b.actionId,contextText:b.row===undefined?'':rowTexts[b.row],disabled:false})),reservedHostCommand:reserved};
 const snapshotBytesUpperBound=Buffer.byteLength(JSON.stringify(snapshot))+2048;
 const graphBytes=Buffer.byteLength(JSON.stringify(nodes));
 const encodedUpperBound=snapshotBytesUpperBound+graphBytes;
 if(encodedUpperBound>NATIVE_VIEW_LIMITS.encodedBytes)fail('expanded snapshot encoding exceeds default Native transfer bound');
 const entities=data.entities as any[];const perRow=entities.length?rowButtons/entities.length:countTemplateButtons(nodes,byId);
 if(!Number.isInteger(perRow)||perRow>3)fail('inconsistent row-action template');
 return{schemaVersion:1,surfaceSha256:createHash('sha256').update(JSON.stringify(nodes)).digest('hex'),rows:entities.length,fields:fields.length,globalButtons,rowButtons:perRow,buttons:buttons.length,reservedHostCommand:reserved,visibleTextUpperBound,encodedBytesUpperBound:encodedUpperBound,snapshotBytesUpperBound,graphBytes,limits:NATIVE_VIEW_LIMITS,scope:'Current complete display resource budget only, never world truth, membership, authorization or a goal score; complete inference/history remains subject to its actual unchanged transport budget'};
}
function countTemplateButtons(nodes:any[],byId:Map<any,any>){
 const list=nodes.find(n=>n.component==='List'&&n.children?.path==='/entities');if(!list)fail('entity template required');let buttons=0;const active=new Set<string>();const walk=(id:string)=>{if(active.has(id))fail('cyclic row template');const n=byId.get(id);if(!n)fail('dangling row template');active.add(id);if(n.component==='Button')buttons++;if(n.child)walk(n.child);if(Array.isArray(n.children))n.children.forEach(walk);active.delete(id);};walk(list.children.componentId);return buttons;
}
