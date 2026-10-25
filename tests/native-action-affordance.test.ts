import test from 'node:test';import assert from 'node:assert/strict';
import {validateDesignedOverview} from '../server/liveuiagent.js';
const components:any[]=[
 {id:'overview',component:'Column',children:['hero','heading','list','result','name','value','create','update']},
 {id:'hero',component:'StatBlock',label:'Count',value:{path:'/draft/statValue'}},
 {id:'heading',component:'SectionHeading',title:'Items'},
 {id:'list',component:'List',children:{componentId:'item',path:'/entities'}},
 {id:'item',component:'Card',child:'itemBody'},{id:'itemBody',component:'Column',children:['itemName','itemDetail']},
 {id:'itemName',component:'Text',text:{path:'name'}},{id:'itemDetail',component:'Text',text:{path:'detail'}},
 {id:'result',component:'Text',text:{path:'/draft/result'}},
 {id:'name',component:'TextField',label:'Item name',variant:'shortText',value:{path:'/draft/slots/name'}},
 {id:'value',component:'TextField',label:'New value',variant:'shortText',value:{path:'/draft/slots/value'}},
 {id:'create',component:'Button',child:'createLabel',action:{event:{name:'actions.create'}}},{id:'createLabel',component:'Text',text:'Add item'},
 {id:'update',component:'Button',child:'updateLabel',action:{event:{name:'actions.update'}}},{id:'updateLabel',component:'Text',text:'Update item'},
];
const options={slots:[{name:'name'},{name:'value'}],actionIds:['actions.create','actions.update'],requireWidgets:true};
test('actual component contract requires every declared action reachable without inventing unsafe targetless entry points',()=>{
 assert.ok(validateDesignedOverview(components,options));
 const missing=structuredClone(components).filter(x=>!['update','updateLabel'].includes(x.id));missing[0].children=missing[0].children.filter((x:string)=>x!=='update');assert.equal(validateDesignedOverview(missing,options),null);
 const rowOnly=structuredClone(components);rowOnly[0].children=rowOnly[0].children.filter((x:string)=>x!=='update');rowOnly.find(x=>x.id==='itemBody').children.push('update');assert.ok(validateDesignedOverview(rowOnly,{...options,requireItemButtonFor:'actions.update'}),'legitimate existing-item-only action keeps host-issued row identity');
 assert.ok(validateDesignedOverview(missing,{...options,requireWidgets:false}),'old stored trees remain readable; strict new-design gate only');
});
