import fs from 'node:fs/promises';
import path from 'node:path';
// Metadata only. This writer never accepts prompts, answers, stderr, URLs,
// headers or provider configuration, and is not connected to an uploader.
export async function persistNativeInferenceDiagnostic(root:string|undefined,id:string,metadata:Record<string,unknown>,write?:()=>Promise<void>) {
 if(!root)return false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const operation=write??(async()=>{
  await fs.mkdir(root,{recursive:true,mode:0o700});const stat=await fs.lstat(root);
  if(stat.isSymbolicLink()||(stat.mode&0o077))throw Object.assign(new Error('Unsafe diagnostic directory'),{code:'unsafe_diagnostic_directory'});
  const temporary=path.join(root,`.${id}.tmp`),file=path.join(root,`${id}.json`);
  await fs.writeFile(temporary,JSON.stringify(metadata,null,2),{mode:0o600,flag:'wx'});await fs.rename(temporary,file);
 });
 try {await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Diagnostic persistence timed out'),{code:'diagnostic_write_timeout'})),1000);})]);return true;}
 catch(error){console.warn(`[native-dsh] diagnostic persistence unavailable (${String((error as any)?.code||'diagnostic_write_failed').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)})`);return false;}
 finally{if(timer)clearTimeout(timer);}
}
