import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=await fs.readFile(process.env.COMPLETE_APP_TEST_SOURCE || new URL('../frontend/snapshot/complete-apps.js',import.meta.url),'utf8');
async function revise(frameMeasurement){
 const state=[],refs=[],posts=[];let stateIndex=0,refIndex=0;
 const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState(initial){const i=stateIndex++;if(!(i in state))state[i]=initial;return [state[i],value=>{state[i]=value}]},useRef(initial){const i=refIndex++;if(!(i in refs))refs[i]={current:i===0?frameMeasurement:initial};return refs[i]},useEffect(){},useMemo:fn=>fn()};
 const sandbox={window:{__liveuiagentReact:React},crypto:webcrypto,innerWidth:1440,innerHeight:900,URL,Blob,setTimeout,clearTimeout,Promise,console,fetch:async(path,options)=>{
  if(options.method==='POST'){posts.push({path,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'fixture-job',status:'queued'})}}
  if(path.includes('/jobs/'))return {ok:true,json:async()=>({id:'fixture-job',status:'done'})};
  return {ok:true,json:async()=>({html:'<html><body>Saved</body></html>',store:{}})};
 }};
 vm.runInNewContext(source,sandbox);
 const render=()=>{stateIndex=0;refIndex=0;return sandbox.window.LiveUIAgentCompleteApp({app:{appId:'fixture-app',name:'清单'}})};
 const all=node=>[node,...(node.children||[]).flat().filter(x=>x&&typeof x==='object').flatMap(all)];
 let tree=render();all(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'把分类收起来'}});tree=render();
 await all(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(posts.length,1);assert.equal(posts[0].path,'/agent/complete/apps/fixture-app/revise');
 return posts[0].body;
}
test('actual revision handler sends measured iframe dimensions separately from outer window',async()=>{
 const body=await revise({clientWidth:372,clientHeight:575});
 assert.deepEqual(JSON.parse(JSON.stringify(body)),{prompt:'把分类收起来',displayEnvironment:{browserViewport:{width:1440,height:900},appViewport:{width:372,height:575}}});
});
test('revision with no current iframe reports unknown app size instead of copying browser size',async()=>{
 const body=await revise(null);assert.equal(body.displayEnvironment.appViewport,null);assert.equal(body.displayEnvironment.browserViewport.width,1440);
});
