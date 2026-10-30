import {spawn} from 'node:child_process';
/** The configured executable is a trusted sandbox launcher, never a shell.
 * It accepts only a workspace and a controller-defined validation identifier. */
export function createDevelopmentTestRunner(executable:string) {
 return async({cwd,commandId,signal}:{cwd:string;commandId:string;signal?:AbortSignal})=>{
  if(signal?.aborted)throw new Error('Development validation cancelled before start');
  if(!['syntax','test'].includes(commandId))throw new Error('Unknown development validation');
  return await new Promise<{exitCode:number;stdout:string;stderr:string}>((resolve,reject)=>{
   const child=spawn(executable,[cwd,commandId],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},detached:true});
   let stdout='',stderr='',settled=false;
   const kill=()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}};
   const timer=setTimeout(kill,150000);signal?.addEventListener('abort',kill,{once:true});
   const append=(key:'stdout'|'stderr',data:Buffer)=>{if(key==='stdout')stdout+=data.toString();else stderr+=data.toString();if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>1024*1024)kill();};
   child.stdout.on('data',data=>append('stdout',data));child.stderr.on('data',data=>append('stderr',data));
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);kill();};
   child.once('error',error=>{if(!settled){settled=true;cleanup();reject(error);}});
   child.once('close',(code,sig)=>{if(!settled){settled=true;cleanup();resolve({exitCode:code??1,stdout,stderr:stderr+(sig?'\nSandbox terminated: '+sig:'')});}});
  });
 };
}
