import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

test('Expo and shipped web resolve projected local metadata as identical scalar values',async()=>{
 const expo=await fs.readFile(new URL('../apps/shell/src/DynamicAppRenderer.tsx',import.meta.url),'utf8');
 const extract=name=>{const a=expo.indexOf(`function ${name}`);const ends=[expo.indexOf('\nfunction ',a+1),expo.indexOf('\nexport function ',a+1)].filter(n=>n>=0);return expo.slice(a,Math.min(...ends));};
 const native={};vm.runInNewContext(ts.transpileModule(['requiredText','resolvePath'].map(extract).join('\n')+'\nglobalThis.resolve=resolvePath',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,native);
 const html=await fs.readFile(new URL('../frontend/snapshot/index.html',import.meta.url),'utf8');const a=html.indexOf('function Hl(');const web={};vm.runInNewContext('function $(v,m){if(typeof v!=="string"||!v.trim())throw Error(m);return v}'+html.slice(a,html.indexOf('function ',a+10))+';globalThis.resolve=Hl;',web);
 for(const resolve of [native.resolve,web.resolve]){const row={appState:{target:199,enabled:false,note:'Not set'}};assert.equal(resolve(row,{path:'appState/target'}),199);assert.equal(resolve(row,{path:'/appState/enabled'}),false);assert.equal(resolve(row,{path:'appState/note'}),'Not set');assert.throws(()=>resolve({appRecords:[]},{path:'/appRecords/0/values/target'}));}
});
