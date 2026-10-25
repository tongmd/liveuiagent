import type {AppWorldToolCapability} from './appworld-bridge.js';
import {requireConsumedSlots} from './native-action-slots.js';
import {schemaDesignCatalog} from './native-schema-design.js';
import {appRecordFields,appStateCapabilitySchemas} from './native-app-state.js';

/** One shared authority filter for planning schemas and actual grounding dispatch. */
export function authorizedGroundingCapabilities(capabilities:AppWorldToolCapability[],permissions:readonly string[]):AppWorldToolCapability[]{
 const allowed=new Set(permissions);
 return capabilities.filter(tool=>tool.appName!=='__meta__'&&allowed.has(tool.permission)&&!/signup|login|logout|verify|verification|password|delete_account/i.test(tool.apiName));
}
type Field={name:string;label:string;type?:string;required?:boolean;options?:Array<{label:string;value:string}>};
export function nativeActionContext(input:{originalAppNeed:string;action:{id:string;label?:string;description?:string;perItem?:boolean;consumedSlots?:unknown};fields:Field[];eventPayload:unknown;requestPayload:Record<string,unknown>;targetEntity?:{name:string;id:string;appRecordId?:string}|null;primaryFieldName?:string;secondaryFieldName?:string;permissions:string[];capabilities:AppWorldToolCapability[]}){
 const eventPayload=input.eventPayload&&typeof input.eventPayload==='object'&&!Array.isArray(input.eventPayload)?input.eventPayload as Record<string,unknown>:{};
 const names=input.fields.map(field=>field.name);
 if(new Set(names).size!==names.length)throw Error('Action context has duplicate declared fields');
 const consumed=input.action.perItem===true?requireConsumedSlots(input.action.consumedSlots,names):null;
 const authorized=authorizedGroundingCapabilities(input.capabilities,input.permissions);
 const publicCapabilities=authorized.filter(tool=>tool.source==='appworld');
 const catalog=schemaDesignCatalog(publicCapabilities,[...new Set(publicCapabilities.map(tool=>tool.appName))]);
 const local=appStateCapabilitySchemas(appRecordFields(input.fields),input.permissions);
 return {
  schemaVersion:1,source:'host-owned-action-contract',originalAppNeed:input.originalAppNeed,
  operation:{id:input.action.id,label:input.action.label,description:input.action.description,perItem:input.action.perItem===true,consumedSlotNames:consumed,consumptionScope:consumed===null?'unknown-global-operation':'exact-declared-row-slots',targetEntity:input.targetEntity?structuredClone(input.targetEntity):null},
  fields:input.fields.map(field=>{
   const source=Object.hasOwn(eventPayload,field.name)?'eventPayload':Object.hasOwn(input.requestPayload,field.name)?'requestPayload':'not_submitted';
   const value=source==='eventPayload'?eventPayload[field.name]:source==='requestPayload'?input.requestPayload[field.name]:undefined;
   return {name:field.name,label:field.label,type:field.type??'string',uiRequired:field.required===true,requiredOrigin:'generated-ui-design-not-api',consumedByCurrentAction:consumed===null?null:consumed.includes(field.name),valueSource:source,valueState:source==='not_submitted'?'not_submitted':value===null?'null':value===''?'empty_string':'present',...(source!=='not_submitted'?{value:structuredClone(value)}:{}),...(field.options?{options:structuredClone(field.options)}:{})};
  }),
  legacyAliases:{prompt:input.primaryFieldName??null,context:input.secondaryFieldName??null,policy:'Convenience aliases are not new business fields. Canonical exact slot names/typed values above determine field association; do not shift values between slots or treat an alias as a new requirement.'},
  actualApiContracts:{source:'current-action-authorized-public-request-schemas',schemaPolicy:'Single public request projection using the same schema sanitizer as design. Credential fields, examples, responses and arbitrary extensions are excluded; host authentication is not a missing user input. Not execution evidence or a permission grant.',appworld:catalog.map((contract,index)=>({...structuredClone(contract),id:publicCapabilities[index].id,permission:publicCapabilities[index].permission,path:publicCapabilities[index].path})),appState:local},
 };
}
export const nativeActionContextPolicy='hostActionContext is host-owned operation metadata, not extra user intent or authorization. Use its exact canonical field name/label/type/valueState/value association; do not shift values between slots or infer values from legacy prompt/context aliases. uiRequired has provenance generated-ui-design-not-api: it is a fallible shared UI constraint, never proof that this operation needs an absent value. Only exact-declared-row-slots gives known consumed fields; unknown-global-operation does not mean every shared field is required for every action. actualApiContracts contains only current-action-authorized public request schemas once; host credentials are not user inputs. API required parameters are prerequisites for the executor to resolve from actual reads/current inputs, not a requirement that every identifier be entered into a UI field. Do not turn an unfilled optional/unrelated/generated-required field or a prior worker plan into a new business goal. Preserve the current submitted request and original app need; delegate legitimate discovery and schema validation to the host executor without inventing missing amounts, identities or choices. If there is an actual safety or feasibility refusal, keep proceed:false; this context never overrides a refusal or proves that any business effect happened.';
