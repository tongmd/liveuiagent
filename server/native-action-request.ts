import {nativeActionPayloadSha256,normalizeNativeActionId} from './native-action-not-started.js';
export function requireActionRequestId(value:unknown):string {
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw Object.assign(Error('A stable UUID requestId is required for each explicit action; no operation was started.'),{status:400,code:'action_request_id_required'});
 return value.toLowerCase();
}
export function actionRequestConflict(message:string):never {throw Object.assign(Error(message),{status:409,code:'action_request_conflict'});}
export type NativeActionReceipt={type:'action_receipt';schema:'native-action-receipt-v2';appId:string;requestId:string;actionId:string;eventPayloadSha256:string;executionId:string;state:'completed';replayed:true;redispatched:false;automaticRetry:false};
export function completedActionReceipt(binding:{appId:string;requestId:string;actionId:string;eventPayload:unknown},executionId:unknown):NativeActionReceipt{
 if(typeof executionId!=='string'||!executionId||executionId.length>100)return actionRequestConflict('Completed receipt has no verified execution binding; inspect evidence.');
 return {type:'action_receipt',schema:'native-action-receipt-v2',appId:binding.appId,requestId:requireActionRequestId(binding.requestId),actionId:normalizeNativeActionId(binding.actionId),eventPayloadSha256:nativeActionPayloadSha256(binding.eventPayload),executionId,state:'completed',replayed:true,redispatched:false,automaticRetry:false};
}

/** Install only host-minted package nonces; preserve an existing app's persisted identities on redesign. */
export function installHostActionNonces(defaultState:unknown, persisted?:Record<string,unknown>):{hostCommandRequestId:string;hostTransportRequestId:string}{
 const defaults=defaultState as Record<string,unknown>|undefined;
 return {hostCommandRequestId:requireActionRequestId(persisted?.hostCommandRequestId ?? defaults?.hostCommandRequestId),hostTransportRequestId:requireActionRequestId(persisted?.hostTransportRequestId ?? defaults?.hostTransportRequestId)};
}
