import test from 'node:test';import assert from 'node:assert/strict';
import{canonicalizeDomainReferences as canonicalize}from'../server/native-domain-references.js';
import{domainFieldUnion,type DomainField}from'../server/native-domain-fields.js';
const input={label:'Finish date',type:'date',required:false,placeholder:'Optional date'};
const state={label:'Finish date',type:'date'};
const normalized:DomainField={name:'finish_date',label:'Finish date',type:'date',required:false};
const normalizedState:DomainField={name:'finish_date',label:'Finish date',type:'date'};
const run=(rawInput:any=input,rawState:any=state,nInput:any=normalized,nState:any=normalizedState)=>canonicalize([rawInput],[rawState],[nInput],[nState]);

test('exact legal cross-array declaration becomes an audited reference without losing raw metadata, UI flags or input identity',()=>{
 const result=run();assert.deepEqual(result.persistedDomainFields,[]);assert.deepEqual(result.schemaFields,[normalized]);assert.equal(result.schemaFields[0].required,false);assert.equal(result.aliasTrace.references[0].canonicalFieldName,'finish_date');assert.deepEqual(result.aliasTrace.references.map(({inputIndex,persistedIndex})=>[inputIndex,persistedIndex]),[[0,0]]);assert.match(result.aliasTrace.references[0].rawTypedIdentitySha256,/^[a-f0-9]{64}$/);assert.deepEqual(result.rawDeclarations,{slots:[input],persistedDomainFields:[state]});assert.deepEqual(result.additionalStateIndices,[]);
 assert.throws(()=>domainFieldUnion([normalized],[normalizedState]),/collision/);// The underlying disjoint union remains strict.
});
test('extra state retains its original normalization index and false/zero types; only redundant declaration is canonicalized',()=>{
 const fields:DomainField[]=[normalizedState,{name:'reviewed',label:'Reviewed',type:'boolean'},{name:'attempts',label:'Attempts',type:'number'}];
 const result=canonicalize([input],[state,{label:'Reviewed',type:'boolean'},{label:'Attempts',type:'number'}],[normalized],fields);
 assert.deepEqual(result.additionalStateIndices,[1,2]);assert.deepEqual(result.persistedDomainFields,fields.slice(1));assert.deepEqual(result.schemaFields.map(f=>[f.name,f.type]),[['finish_date','date'],['reviewed','boolean'],['attempts','number']]);assert.equal(result.aliasTrace.references.length,1);
});
test('different complete raw labels never merge after compact/NFKC/whitespace/case loss',()=>{
 for(const label of ['Finish Date',' Finish date','Finish  date','Ｆinish date','Finish date for an unrelated object'])assert.throws(()=>run(input,{label,type:'date'}),/not an exact/);
 const rawA={...input,label:'Complete delivery date for customer A'};const rawB={...state,label:'Complete delivery date for customer B'};
 assert.throws(()=>run(rawA,rawB,{...normalized,name:'complete_deliver',label:'Complete deliver…'},{...normalizedState,name:'complete_deliver',label:'Complete deliver…'}),/not an exact/);
 assert.deepEqual(run({...input,label:rawA.label},{...state,label:rawA.label},{...normalized,name:'complete_deliver',label:'Complete deliver…'},{...normalizedState,name:'complete_deliver',label:'Complete deliver…'}).persistedDomainFields,[]);// Full raw equality is checked before display compaction.
});
test('different type, select option value/label/order or presence cannot be merged',()=>{
 assert.throws(()=>run(input,{...state,type:'string'},normalized,{...normalizedState,type:'string'}),/not an exact/);
 const options=[{label:'Done',value:'done'},{label:'Open',value:'open'}];const ri={label:'Disposition',type:'select',required:false,options};const rs={label:'Disposition',type:'select',options};const ni:DomainField={name:'disposition',label:'Disposition',type:'select',required:false,options};const ns:DomainField={name:'disposition',label:'Disposition',type:'select',options};assert.equal(run(ri,rs,ni,ns).aliasTrace.references.length,1);
 for(const changed of [[...options].reverse(),[{label:'Finished',value:'done'},options[1]],[{label:'Done',value:'DONE'},options[1]]])assert.throws(()=>run(ri,{...rs,options:changed},ni,{...ns,options:changed}),/not an exact/);
 assert.throws(()=>run(ri,{label:'Disposition',type:'select'},ni,ns),/requires explicit options/);
 assert.throws(()=>run(input,{...state,options:[]}),/Only select/);
});
test('all declarations pass strict metadata gates before an otherwise identical reference can merge',()=>{
 for(const extra of [{name:'finish_date'},{required:false},{hiddenInForm:false},{default:null},{defaultValue:'2026-01-01'},{unrecognized:true}])assert.throws(()=>run(input,{...state,...extra}),/forbidden metadata/);
 assert.throws(()=>run({...input,unknown:true}),/forbidden metadata/);
 assert.throws(()=>run({...input,required:undefined}),/required boolean/);
 assert.throws(()=>run({...input,type:undefined}),/explicit valid type/);
 assert.throws(()=>run({label:'Context',type:'string',required:false},{label:'Context',type:'string'},{name:'context',label:'Context',type:'string',required:false},{name:'context',label:'Context',type:'string'}),/namespace/);// Existing workflow-like input cannot authorize persistent state.
 assert.throws(()=>canonicalize([input],[state,state],[normalized],[normalizedState,normalizedState]),/inside persistedDomainFields/);
});
test('ambiguous identities, unknown schema fields and slot mapping are not silently guessed or reindexed',()=>{
 assert.throws(()=>canonicalize([input],[state],[normalized],[]),/mapping mismatch/);
 assert.throws(()=>canonicalize([input],[state],[normalized],[{...normalizedState,name:'other_name'}]),/collision/);// Same literal label cannot silently choose a different local schema name.
 assert.throws(()=>run(input,state,normalized,{...normalizedState,type:'number'}),/changed the explicit type/);
 assert.throws(()=>canonicalize([input],Array.from({length:13},()=>state),[normalized],Array.from({length:13},()=>normalizedState)),/cardinality/);
});
