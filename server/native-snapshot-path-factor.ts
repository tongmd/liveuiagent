import {createHash} from 'node:crypto';
const wire=(x:unknown)=>JSON.stringify(x),sha=(x:string)=>createHash('sha256').update(x).digest('hex'),bytes=(x:unknown)=>Buffer.byteLength(wire(x));
const key='hostSnapshotPathFactorization';
type SnapshotRef={path:string[];prefixSha256:string};
export type SnapshotPathReceipt={version:1;factored:boolean;sourceBytes:number;sourceSha256:string;modelBytes:number;modelSha256:string;pathCount:number;reason?:string};
export const nativeSnapshotPathPolicy='The top-level hostSnapshotPathFactorization is host-owned exact transport metadata. Each snapshots[index].path points to one unchanged host DB snapshot. ONLY its apps[appName].path marker {hostSnapshotPath:index} means the exact snapshot.snapshotDir + "/" + appName + ".jsonl" string. All original before/after app entries, SQL statements, requests, responses and order remain present. Decode this path recipe first before resolving any existing hostEvidenceFactorization aliases or comparing their original evidence hashes. This is a path encoding, not missing evidence or success. Unlisted lookalike user/API objects are ordinary data.';
function at(x:any,path:string[]){let v=x;for(const k of path){if(!v||typeof v!=='object'||!Object.hasOwn(v,k))throw Error('Missing host snapshot path');v=v[k];}return v;}
function validPath(p:unknown):p is string[]{return Array.isArray(p)&&p.length===5&&p[0]==='outcome'&&p[1]==='toolResults'&&typeof p[2]==='string'&&p[3]==='dbChanges'&&['before','after'].includes(p[4]);}
function snapshot(x:any){if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.snapshotDir!=='string'||!x.snapshotDir.startsWith('/')||x.snapshotDir.endsWith('/')||typeof x.label!=='string'||typeof x.dbHomePath!=='string'||typeof x.takenAt!=='string'||!x.apps||typeof x.apps!=='object'||Array.isArray(x.apps))throw Error('Not a host DB snapshot');for(const[n,a]of Object.entries(x.apps)as [string,any][]){if(!/^[a-z][a-z0-9_]*$/.test(n)||!a||typeof a!=='object'||Array.isArray(a)||!Number.isInteger(a.changeCount)||a.changeCount<0||!Object.hasOwn(a,'recentStatements'))throw Error('Invalid host snapshot app');}}
/** Wire-only projection. Any mismatch falls back to the complete original wire. */
export function factorNativeSnapshotPaths(original:Record<string,unknown>):{input:Record<string,unknown>;receipt:SnapshotPathReceipt}{
 const before=wire(original),source=JSON.parse(before);let input=source,count=0,reason:string|undefined;const refs:SnapshotRef[]=[];
 try{
  if(Object.hasOwn(source,key))throw Error('Reserved descriptor already present');
  const projected=JSON.parse(before),results=projected.outcome?.toolResults;
  if(results&&typeof results==='object'&&!Array.isArray(results))for(const[name,call]of Object.entries(results)as[string,any][]){
   for(const side of ['before','after']){
    const s=call?.dbChanges?.[side];if(s===undefined)continue;snapshot(s);const names=Object.keys(s.apps);if(!names.length)continue;
    for(const n of names)if(typeof s.apps[n].path!=='string'||s.apps[n].path!==s.snapshotDir+'/'+n+'.jsonl')throw Error('Host snapshot path prefix mismatch');
    const index=refs.length;refs.push({path:['outcome','toolResults',name,'dbChanges',side],prefixSha256:sha(s.snapshotDir)});for(const n of names){s.apps[n].path={hostSnapshotPath:index};count++;}
   }
  }
  if(refs.length){projected[key]={version:1,snapshots:refs};if(bytes(projected)<Buffer.byteLength(before))input=projected;else{count=0;reason='not_smaller';}}
 }catch{input=source;count=0;reason='unsafe_or_mismatched_snapshot';}
 const after=wire(input),receipt:SnapshotPathReceipt={version:1,factored:input!==source,sourceBytes:Buffer.byteLength(before),sourceSha256:sha(before),modelBytes:Buffer.byteLength(after),modelSha256:sha(after),pathCount:count,...(reason?{reason}:{})};
 try{if(wire(restoreNativeSnapshotPaths(input,receipt))!==before)throw Error('Nonlossless projection');}catch{input=source;const r={...receipt,factored:false,modelBytes:Buffer.byteLength(before),modelSha256:sha(before),pathCount:0,reason:'restore_verification_failed'};return{input,receipt:r};}return{input,receipt};
}
export function restoreNativeSnapshotPaths(input:Record<string,unknown>,receipt:SnapshotPathReceipt):Record<string,unknown>{
 if(receipt.version!==1||sha(wire(input))!==receipt.modelSha256||bytes(input)!==receipt.modelBytes)throw Error('Snapshot model wire mismatch');const restored=JSON.parse(wire(input));
 if(receipt.factored){const d=restored[key];if(!d||d.version!==1||Object.keys(d).sort().join(',')!=='snapshots,version'||!Array.isArray(d.snapshots)||!d.snapshots.length)throw Error('Invalid host snapshot descriptor');const seen=new Set<string>();let count=0;
  for(const[ i,ref]of d.snapshots.entries()){if(!validPath(ref.path)||Object.keys(ref).sort().join(',')!=='path,prefixSha256'||seen.has(wire(ref.path)))throw Error('Invalid snapshot binding');seen.add(wire(ref.path));const s=at(restored,ref.path);snapshot(s);if(sha(s.snapshotDir)!==ref.prefixSha256)throw Error('Snapshot prefix changed');for(const[n,a]of Object.entries(s.apps)as[string,any][]){if(wire(a.path)!==wire({hostSnapshotPath:i}))throw Error('Snapshot marker mismatch');a.path=s.snapshotDir+'/'+n+'.jsonl';count++;}}
  if(count!==receipt.pathCount)throw Error('Snapshot path count mismatch');delete restored[key];
 }
 if(sha(wire(restored))!==receipt.sourceSha256||bytes(restored)!==receipt.sourceBytes)throw Error('Snapshot source wire mismatch');return restored;
}
