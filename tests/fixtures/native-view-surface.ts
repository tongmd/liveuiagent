import {validateDesignedOverview} from '../../server/liveuiagent.js';
import {rowActionSlotMap} from '../../server/native-action-slots.js';
import {compileSemanticSurface} from '../../server/native-surface-design.js';
import {appendHostCommand} from '../../server/native-host-command.js';
export function viewFixture(count:number,{rowActions=3,host=true,metadata=''}:{rowActions?:number;host?:boolean;metadata?:string}={}){
 const fields=[{name:'name',label:'Entry name',type:'string' as const},{name:'amount',label:'Amount',type:'number' as const},{name:'enabled',label:'Enabled',type:'boolean' as const}];
 const actions=[{actionId:'add.run',label:'Add entry'},...Array.from({length:rowActions},(_,i)=>({actionId:'row'+i+'.run',label:['Edit','Complete','Remove'][i],perItem:true,consumedSlots:[]}))];
 const compiled=compileSemanticSurface({schemaVersion:1,sectionOrder:['summary','composer','records'],layout:{fields:'stacked',records:'cards'},headings:{records:'Entries',composer:'New entry'},recordFields:['name']},{businessFields:fields,actions,persistedStateFields:fields});
 const checked=validateDesignedOverview(compiled.components,{slots:fields,actionIds:actions.map(a=>a.actionId),rowActionSlots:rowActionSlotMap(actions,fields.map(f=>f.name)),requireWidgets:true});if(!checked)throw Error('Fixture real strict surface validation failed');
 const components=[{id:'root',component:'Card',child:'wrapper'},{id:'wrapper',component:'Column',children:['d_overview']},...checked.map(n=>n.component==='Button'&&!n.action.event.context?{...n,action:{event:{...n.action.event,context:Object.fromEntries(fields.map(f=>[f.name,{path:'/draft/slots/'+f.name}]))}}}:n)];
 const data={draft:{statLabel:'Entries',statValue:String(count),result:'Fixture current view',slots:{name:'',amount:0,enabled:false}},stats:[],entities:Array.from({length:count},(_,i)=>({name:'Entry '+i,title:'Entry '+i,detail:'Current detail '+i,tag:'Current',entityName:'Entry '+i,id:String(i),appState:{name:metadata||'Local '+i,amount:0,enabled:false}}))};
 const surface:any={protocol:'a2ui',surfaceId:'fixture',initialData:data,messages:[{updateComponents:{surfaceId:'fixture',components}},{updateDataModel:{surfaceId:'fixture',value:data}}],actionMap:Object.fromEntries(actions.map(a=>[a.actionId,{actionId:a.actionId,payloadSource:'event.context'}]))};
 if(host){const appended=appendHostCommand(surface,{},'11111111-1111-4111-8111-111111111111');return{...appended,data:appended.surface.initialData,fields,actions};}
 return{surface,descriptor:undefined,data,fields,actions};
}
