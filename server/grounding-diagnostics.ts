import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {groundingEvidenceHistory} from './grounding-evidence.js';
export type GroundingDiagnosticsReceipt = {status:'written';id:string;sha256:string;apiEventCount:number;proposalCount:number}|{status:'not_written';reason:'diagnostics_unavailable'};
/** Explicit private experiment opt-in. Never return a file path or raw data. */
export function writeGroundingDiagnostics(payload:Record<string,unknown>):GroundingDiagnosticsReceipt|undefined {
 const root=process.env.LIVEUIAGENT_GROUNDING_DIAGNOSTICS_ROOT;
 if(!root)return undefined;
 let temporary:string|undefined;
 try {
  if(!path.isAbsolute(root))throw Error('Absolute diagnostics root required');
  fs.mkdirSync(root,{recursive:true,mode:0o700});const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||(process.getuid&&stat.uid!==process.getuid()))throw Error('Private owned diagnostics root required');
  const id=randomUUID();const safe=groundingEvidenceHistory([payload])[0];
  const payloadBytes=Buffer.from(JSON.stringify(safe));const payloadSha256=createHash('sha256').update(payloadBytes).digest('hex');
  const envelope={schemaVersion:1,id,createdAt:new Date().toISOString(),payloadSha256,scope:'Private grounding audit; proposals and prior projection are not established business truth. No automatic replay is authorized.',payload:safe};
  const bytes=Buffer.from(JSON.stringify(envelope,null,2)+'\n');temporary=path.join(root,`.${id}.tmp`);
  const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Hard-link publication is atomic and exclusive; unlike rename it cannot replace an existing receipt.
  fs.linkSync(temporary,path.join(root,`${id}.json`));fs.unlinkSync(temporary);temporary=undefined;
  return {status:'written',id,sha256:createHash('sha256').update(bytes).digest('hex'),apiEventCount:Array.isArray(safe.orderedHostCalls)?safe.orderedHostCalls.length:0,proposalCount:Array.isArray(safe.proposals)?safe.proposals.length:0};
 } catch {
  if(temporary)try{fs.unlinkSync(temporary);}catch{}
  // Audit IO failure never changes the business verdict or retries a mutation.
  return {status:'not_written',reason:'diagnostics_unavailable'};
 }
}
