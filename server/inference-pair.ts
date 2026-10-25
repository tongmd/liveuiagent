import {remainingActionMs} from './action-deadline.js';
// These are server-owned adapter facts, never application JSON. Start lazily:
// eagerly constructing both promises would still spend the second role's
// deadline in a capacity-one queue.
export async function independentInferencePair<A,B>(adapter:{chatCompletion?:unknown;nativeInferenceConcurrency?:number}|undefined,first:()=>Promise<A>,second:()=>Promise<B>):Promise<[A,B]> {
 if(adapter?.chatCompletion && adapter.nativeInferenceConcurrency===1){
  remainingActionMs();const a=await first();remainingActionMs();return [a,await second()];
 }
 return Promise.all([first(),second()]);
}
