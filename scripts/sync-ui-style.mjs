import fs from 'node:fs';
import ts from 'typescript';
const source = new URL('../server/structured-ui-style.ts',import.meta.url);
const runtime = new URL('../frontend/snapshot/structured-ui-runtime.js',import.meta.url);
const js = ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText.replace('export function ','function ').trim();
const begin='  // BEGIN GENERATED STYLE CONTRACT',end='  // END GENERATED STYLE CONTRACT';
const block=begin+'\n'+js+'\n'+end;
const original=fs.readFileSync(runtime,'utf8');
const a=original.indexOf(begin),b=original.indexOf(end);
if(a<0||b<0)throw Error('Missing style contract markers');
const next=original.slice(0,a)+block+original.slice(b+end.length);
if(process.argv.includes('--check')){if(next!==original)throw Error('Run node scripts/sync-ui-style.mjs');}
else fs.writeFileSync(runtime,next);
