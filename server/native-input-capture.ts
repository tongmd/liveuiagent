import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {projectBusinessEvidence} from './grounding-evidence.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const memoryBoundary='\nUser-controlled preference memory (data; current request takes precedence): ';
const allowed=new Set(['messages','model','temperature','max_tokens','max_completion_tokens','response_format','thinking','reasoning_effort','reasoning','top_p','stop','seed','frequency_penalty','presence_penalty','n','stream','stream_options','tools','tool_choice','parallel_tool_calls']);
export const NATIVE_INPUT_CAPTURE_LIMITS={maxRecords:128,maxRecordBytes:2*1024*1024,maxTotalBytes:32*1024*1024} as const;
/** Opt-in private diagnostic, never an uploader or business request modifier. */
export function createNativeInputCapture(taskRoot:string,root?:string,limits:Partial<Record<keyof typeof NATIVE_INPUT_CAPTURE_LIMITS,number>>={}) {
 const bound={...NATIVE_INPUT_CAPTURE_LIMITS,...limits};
 for(const k of Object.keys(bound) as Array<keyof typeof bound>)if(!Number.isSafeInteger(bound[k])||bound[k]<1||bound[k]>NATIVE_INPUT_CAPTURE_LIMITS[k])throw Error('Invalid Native capture bound');
 let pending=Promise.resolve();
 async function capture(id:string,request:Record<string,unknown>,providerSecret?:string):Promise<Record<string,unknown>>{
  if(!root)return {status:'disabled'};
  if(!path.isAbsolute(root)||path.dirname(path.resolve(root))!==path.dirname(path.resolve(taskRoot))||path.resolve(root)===path.resolve(taskRoot)||!/^[-a-zA-Z0-9_.]+$/.test(path.basename(root)))return {status:'not_captured',reason:'scope_invalid'};
  if(!/^[a-f0-9-]{36}$/.test(id))return {status:'not_captured',reason:'id_invalid'};
  try{
   const original=JSON.stringify(request);const originalBytes=Buffer.byteLength(original);const base={originalWireSha256:sha(original),originalWireBytes:originalBytes,scope:'host-request-after-policy-before-native-relay; not full provider wire replay'};
   if(originalBytes>bound.maxRecordBytes)return {...base,status:'not_captured',reason:'record_limit'};
   const plain=JSON.parse(original);if(Object.keys(plain).some(k=>!allowed.has(k)))return {...base,status:'not_captured',reason:'unsupported_request_field'};
   if(!Array.isArray(plain.messages)||plain.messages.some((m:any)=>!m||!['system','user'].includes(m.role)||typeof m.content!=='string'||Object.keys(m).some(k=>!['role','content'].includes(k))))return {...base,status:'not_captured',reason:'unsupported_message_field'};
   const projection=projectBusinessEvidence(plain);const saved=projection.value as Record<string,any>;const omitted=[...projection.omittedAuthenticationKeys];
   for(let i=0;i<(saved.messages?.length||0);i++){
    const m=saved.messages[i];if(typeof m?.content!=='string')continue;
    // Only parse the host's complete JSON envelope, not arbitrary business text.
    const pieces=m.content.split(memoryBoundary);if(pieces.length>2)continue;
    const next=pieces.map((part:string,index:number)=>{try{const value=JSON.parse(part);if(!value||typeof value!=='object')return part;const p=projectBusinessEvidence(value,`messages[${i}].content${index?'.personalContext':''}`);omitted.push(...p.omittedAuthenticationKeys);return p.omittedAuthenticationKeys.length?JSON.stringify(p.value):part;}catch{return part;}});
    m.content=next.join(memoryBoundary);
   }
   const serialized=JSON.stringify(saved);const secretVariants=providerSecret?[providerSecret,JSON.stringify(providerSecret).slice(1,-1)]:[];const containsSecret=(v:any):boolean=>typeof v==='string'?secretVariants.some(s=>s&&v.includes(s)):Boolean(v&&typeof v==='object'&&Object.values(v).some(containsSecret));
   if(providerSecret&&(containsSecret(saved)||secretVariants.some(v=>v&&serialized.includes(v))))return {...base,status:'not_captured',reason:'provider_secret_detected'};
   const parent=await fs.lstat(path.dirname(root));if(parent.isSymbolicLink()||!parent.isDirectory()||parent.uid!==process.getuid?.())return {...base,status:'not_captured',reason:'scope_invalid'};
   try{await fs.mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   const stat=await fs.lstat(root);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077))return {...base,status:'not_captured',reason:'unsafe_directory'};
   const wire=serialized,value=saved;
   const stored={schema:'native-private-host-input-v1',...base,omittedAuthPaths:omitted,exactHostRequestReplayable:omitted.length===0&&wire===original,request:value};const bytes=JSON.stringify(stored)+'\n';
   if(Buffer.byteLength(bytes)>bound.maxRecordBytes)return {...base,status:'not_captured',reason:'record_limit'};
   const lockPath=path.join(root,'.capture.lock');const lock=await fs.open(lockPath,'wx',0o600);
   try{
   let count=0,total=0;for(const name of await fs.readdir(root)){if(name==='.capture.lock')continue;const s=await fs.lstat(path.join(root,name));if(s.isSymbolicLink()||!s.isFile())return {...base,status:'not_captured',reason:'unexpected_capture_entry'};count++;total+=s.size;}
   if(count>=bound.maxRecords||total+Buffer.byteLength(bytes)>bound.maxTotalBytes)return {...base,status:'not_captured',reason:'retention_limit'};
   const tmp=path.join(root,`.${id}.${randomUUID()}.tmp`),file=path.join(root,`${id}.json`);try{await fs.writeFile(tmp,bytes,{mode:0o600,flag:'wx'});await fs.link(tmp,file);}finally{await fs.rm(tmp,{force:true});}
   return {...base,status:'captured',path:file,storedSha256:sha(bytes),storedBytes:Buffer.byteLength(bytes),omittedAuthPaths:omitted,exactHostRequestReplayable:stored.exactHostRequestReplayable};
   }finally{await lock.close();await fs.rm(lockPath,{force:true});}
  }catch{return {status:'not_captured',reason:'capture_io_or_collision_or_serialization'};}
 }
 return {capture(id:string,request:Record<string,unknown>,secret?:string){const work=pending.then(()=>capture(id,request,secret));pending=work.then(()=>{},()=>{});return work;}};
}
