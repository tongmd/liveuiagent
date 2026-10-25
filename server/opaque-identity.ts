/** Routing identities are opaque data, never display text. Preserve every code
 * unit; reject oversize/invalid identities instead of creating a lossy alias. */
export function opaqueIdentity(value:unknown):string {
 if(value===undefined||value===null)return '';
 if(typeof value!=='string'&&(typeof value!=='number'||!Number.isSafeInteger(value)))throw Error('Opaque identity must be a string or safe integer');
 const result=String(value);
 if(result.length>1000)throw Error('Opaque identity exceeds 1000 characters');
 if(!result.trim())return '';
 return result;
}
