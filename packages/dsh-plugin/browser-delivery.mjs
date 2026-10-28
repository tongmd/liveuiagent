import { validatePresentationContract } from './presentation-contract.mjs';
import { normalizeDeliveryViewport } from './delivery-viewport.mjs';
export { normalizeDeliveryViewport } from './delivery-viewport.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { validateVerificationInput } from './delivery.mjs';

async function executable(explicit) {
  for (const file of [explicit, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (!file) continue;
    try { await fs.access(file); return file; } catch { /* next installed browser */ }
  }
  throw Error('Chrome is required for delivery verification; configure CHROME_PATH');
}

// Deliberately a startup gate, not a claim that business workflows pass.
export async function validateBrowserDelivery(html, { chrome, signal, settleMs = 350, requireAgentAction = false, viewport, presentationContract, verificationInput } = {}) {
  const presentation=validatePresentationContract(presentationContract);
  const fixture=validateVerificationInput(verificationInput);
  let browser;
  let actionPhase = false;
  let outcome = 'failure';
  const agentCalls = [];
  const token = randomBytes(10).toString('hex');
  const syntheticRequest = `Process this current user request: delivery-check-${token}`;
  const serviceError = `Connected service unavailable: delivery-error-${token}`;
  const serviceSuccess = {ok:true,status:'succeeded',text:`Observed service result: delivery-success-${token}`,data:{entities:[{id:`delivery-${token}`,name:`Observed entity ${token}`,detail:`Observed detail ${token}`,group:`unknown-group-${token}`},{name:`Second entity ${token}`,detail:`Second detail ${token}`,group:`other-group-${token}`}],stats:[{label:`Observed count ${token}`,value:'1'}],evaluation:{pass:true,deficiencies:[]}}};
  let actionVerification, presentationVerification, inputVerification;
  let presentationCalls=0;
  let presentationProbe, presentationFrame;
  const presentationStorage = new Map(), presentationSaves = [];
  const presentationError = `UI generation unavailable: delivery-ui-error-${token}`;
  const errors = [];
  const layoutChecks = [];
  const requestedViewport = normalizeDeliveryViewport(viewport);
  const add = (code, message, details) => { if (errors.length < 12 && !errors.some(e => e.code === code && e.message === message)) errors.push({ code, message: String(message).slice(0, 600),...(details?{details}:{}) }); };
  const stop = () => browser?.process()?.kill('SIGKILL');
  const budgetMs = requireAgentAction ? 40000 : 25000;
  const deadline = setTimeout(() => { add('browser_deadline', `Browser delivery verification exceeded ${budgetMs / 1000} seconds`); stop(); }, budgetMs);
  try {
    signal?.throwIfAborted();
    browser = await puppeteer.launch({ executablePath: await executable(chrome), headless: true, timeout: 10000, protocolTimeout: 5000, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    signal?.addEventListener('abort', stop, { once: true });
    signal?.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setViewport({ width: 1280, height: 900 });
    page.on('pageerror', error => add('browser_script_error', error.message));
    page.on('console', event => { if (event.type() === 'error') add('browser_console_error', event.text()); });
    page.on('dialog', async dialog => { add('browser_dialog', `Unexpected ${dialog.type()}: ${dialog.message()}`); await dialog.dismiss().catch(() => {}); });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/^(about:|data:|blob:)/.test(request.url())) void request.continue().catch(() => {});
      else { add('browser_external_request', 'Standalone app attempted an external request'); void request.abort().catch(() => {}); }
    });
    const channel = randomBytes(16).toString('hex');
    await page.exposeFunction('__deliveryViolation', (key, message) => { if (key === channel) add('browser_policy_violation', message); });
    if (requireAgentAction) await page.exposeFunction('__deliveryAgentAction', (key, prompt, context, primaryAction) => {
      if (key !== channel) throw Error('Invalid delivery bridge channel');
      if (!actionPhase || !primaryAction) { add('agent_action_before_submit', 'Call the host service from the bound primary submit action, not startup or input-change handlers'); throw Error('Service actions require an explicit user action'); }
      agentCalls.push({ prompt, context });
      // Count browser SDK invocations, not the real host's internal API plan.
      // Let both handlers run normally so duplicate writes are detected rather
      // than hidden by propagation suppression or a fake single-call wrapper.
      if (agentCalls.length > 1) add('agent_action_contract', `A single primary submit invoked window.liveuiagent.ai ${agentCalls.length} times on the ${outcome} probe. Use one host SDK invocation per submit; compose multiple service API operations inside that host action.`);
      return outcome === 'success' ? serviceSuccess : { ok: false, text: serviceError, error: serviceError, data: { ok: false, error: serviceError } };
    });
    if(presentation)await page.exposeFunction('__deliveryPresentationAction',(key,prompt,context,trustedAction)=>{
      if(key!==channel||context?.uiProtocol!=='liveui-tree-v1')throw Error('Invalid presentation bridge request');
      presentationCalls++;
      if(!presentationProbe||!trustedAction||typeof prompt!=='string'||!prompt.includes(presentationProbe.request)){
        add('browser_presentation_contract','Generate a new UI only from the visible submit button and forward its current requirement.');
        throw Error('Presentation generation requires the current explicit user action');
      }
      if(++presentationProbe.calls!==1){add('browser_presentation_contract','One UI submit must invoke ui.generate exactly once.');throw Error('Duplicate presentation generation');}
      if(presentationProbe.failure)throw Error(presentationError);
      return{text:'Controlled component tree',requestId:context.requestId,data:{tree:controlledPresentationTree(presentation.components,presentationProbe.variant,token,context)}};
    });
    await page.exposeFunction('__deliveryStorageSave',async(key,storageKey,value)=>{
      if(key!==channel||typeof storageKey!=='string'||!storageKey)throw Error('Invalid storage bridge request');
      let treeCommit=false;
      if(presentationProbe&&!presentationProbe.failure&&!presentationProbe.savedMarker&&presentationFrame){
        const marker=`delivery-tree-${token}-${presentationProbe.variant}`;
        treeCommit=typeof value==='string'&&value.includes(marker);
        if(treeCommit&&await presentationFrame.evaluate(marker=>document.body.innerText.includes(marker),marker))throw Error('The generated view was displayed before storage acknowledgement');
      }
      // An asynchronous host ACK, not a synchronous localStorage write.
      await new Promise(resolve=>setTimeout(resolve,20));
      presentationStorage.set(storageKey,String(value));presentationSaves.push({key:storageKey,value:String(value),acknowledged:true});
      if(treeCommit&&presentationProbe)presentationProbe.savedMarker=true;
      return{ok:true};
    });
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    // Match the host's opaque-origin storage API. AI is unavailable during startup
    // checks: a real request must happen through an explicit user action later.
    const structuredRuntime = await fs.readFile(new URL('../../frontend/snapshot/structured-ui-runtime.js', import.meta.url),'utf8');
    const runtimeBootstrap='<script>'+structuredRuntime+`;(()=>{let saveCount=0;const originalSave=window.liveuiagent.save;window.liveuiagent.save=async(k,v)=>{const ack=await originalSave(k,v);saveCount++;return ack;};Object.defineProperty(window,'__deliveryUiSaveCount',{value:()=>saveCount,writable:false});const ui=window.__liveuiStructuredRuntime(window.liveuiagent);const originalGenerate=ui.generate,originalRender=ui.render;let generationCount=0,renderCount=0;Object.defineProperty(ui,'generate',{value:async function(...args){generationCount++;return originalGenerate.apply(ui,args);},writable:false});Object.defineProperty(ui,'render',{value:function(...args){renderCount++;return originalRender.apply(ui,args);},writable:false});Object.defineProperty(window,'__deliveryUiGenerationCount',{value:()=>generationCount,writable:false});Object.defineProperty(window,'__deliveryUiRenderCount',{value:()=>renderCount,writable:false});Object.defineProperty(window.liveuiagent,'ui',{value:Object.freeze(ui),writable:false});})();</script>`;
    const loadApp = async ({restorePresentation=false}={}) => {
      const initialValues = JSON.stringify(restorePresentation?Object.fromEntries(presentationStorage):{}).replace(/</g,'\\u003c');
      const bootstrap = `<script>(${installDeliverySdk.toString()})(${JSON.stringify(channel)},${JSON.stringify(requireAgentAction)},${JSON.stringify(Boolean(presentation))},${initialValues});</script>`;
      const injected = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + policy + bootstrap + runtimeBootstrap) : policy + bootstrap + runtimeBootstrap + html;
      await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="app" sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
      await page.evaluate(({ html, channel }) => {
        const iframe = document.querySelector('#app');
        addEventListener('message', event => { if (event.source !== iframe.contentWindow || event.data?.channel !== channel) return;
          if(event.data.type==='presentation'){const {id,prompt,context,presentationAction}=event.data;window.__deliveryPresentationAction(channel,prompt,context,presentationAction).then(value=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',value},'*'),error=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',error:error.message},'*'));}
          else if(event.data.type==='save'){const {id,storageKey,value}=event.data;window.__deliveryStorageSave(channel,storageKey,value).then(value=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',value},'*'),error=>iframe.contentWindow?.postMessage({channel,id,type:'agent-reply',error:error.message},'*'));}
          else if (event.data.type === 'agent') {
            const { id, prompt, context, primaryAction } = event.data;
            window.__deliveryAgentAction(channel, prompt, context, primaryAction).then(value => iframe.contentWindow?.postMessage({ channel, id, type: 'agent-reply', value }, '*'), error => iframe.contentWindow?.postMessage({ channel, id, type: 'agent-reply', error: error.message }, '*'));
          } else void window.__deliveryViolation(channel, event.data.violation); });
        iframe.srcdoc = html;
      }, { html: injected, channel });
      const frame = await page.waitForFrame(frame => frame.parentFrame() === page.mainFrame());
      await frame.waitForFunction(() => document.readyState === 'complete');
      await new Promise(resolve => setTimeout(resolve, settleMs));
      if (requireAgentAction && await frame.evaluate(() => [...document.querySelectorAll('[data-liveui-view="records"]')].some(node => node.textContent.trim()))) {
        add('agent_action_contract', 'A fresh connected app must start with an empty data-liveui-view="records" surface. Do not prefill unobserved service records or business values. Put headings, empty-state text and user-provided editable drafts/preferences outside this observed-record surface; ask for missing amounts/dates rather than inventing service facts.');
      }
      return frame;
    };
    let frame = await loadApp();presentationFrame=frame;
    signal?.throwIfAborted();
    const visible = await frame.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      return [...body.querySelectorAll('*')].some(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && (e.textContent?.trim() || /^(INPUT|TEXTAREA|SELECT|CANVAS|SVG|IMG)$/.test(e.tagName)); });
    });
    if (!visible) add('browser_empty_page', 'Application has no visible content after startup');
    // Measure the app iframe, not the outer host page. Reuse this same browser,
    // SDK policy and total deadline; resizing never calls real AI or services.
    const viewports = [requestedViewport ?? {width:1280,height:900}, {width:390,height:844}];
    for (const size of viewports.filter((v,i,a)=>a.findIndex(x=>x.width===v.width&&x.height===v.height)===i)) {
      await page.setViewport(size);
      await new Promise(resolve => setTimeout(resolve, 50));
      const measured = await frame.evaluate(measureDeliveryLayout);
      measured.violations.push(...await verifyExplicitDisclosures(frame));
      layoutChecks.push({...size,...measured});
      for (const violation of measured.violations) add('browser_layout', `${size.width}x${size.height}: ${violation}`);
    }
    await page.setViewport(requestedViewport ?? {width:1280,height:900});
    if(presentation&&!errors.length){try{
      if(fixture)inputVerification=await uploadPresentationVerificationInput(frame,fixture,settleMs);
      const verified=await verifyPresentation(frame,{contract:presentation,token,error:presentationError,setProbe:value=>{presentationProbe=value;},getCalls:()=>presentationCalls,getSaves:()=>presentationSaves,restore:async()=>{const restored=await loadApp({restorePresentation:true});presentationFrame=restored;return restored;}});
      presentationVerification=verified.verification;frame=verified.frame;
    }catch(error){add('browser_presentation_contract',error.message,error.deliveryDiagnostic);}finally{presentationProbe=undefined;}}
    if (requireAgentAction && !errors.length) {
      try {
        const failure = await verifyAgentAction(frame, syntheticRequest, serviceError, agentCalls, () => { actionPhase = true; });
        if (!errors.length) {
          // A fresh opaque frame gives success an independent startup, storage and
          // trusted-click boundary; failure UI state must not mask success bugs.
          actionPhase = false; outcome = 'success'; agentCalls.length = 0;
          frame = await loadApp();
          const success = await verifyAgentAction(frame, syntheticRequest + ' success path', serviceSuccess.text, agentCalls, () => { actionPhase = true; }, serviceSuccess.data.entities);
          await new Promise(resolve => setTimeout(resolve, settleMs));
          actionPhase = false; outcome = 'failure'; agentCalls.length = 0;
          const retained = await verifyAgentAction(frame, syntheticRequest + ' retained failure', serviceError, agentCalls, () => { actionPhase = true; });
          actionVerification = {displayedDomainRecords:true,preservedRecordsOnFailure:true,calls:failure.calls + success.calls + retained.calls,forwardedInput:true,displayedHostError:true,displayedHostSuccess:true,failureCalls:failure.calls,successCalls:success.calls,scope:'synthetic-host-failure-and-success',realServiceExecuted:false};
        }
      }
      catch (error) { add('agent_action_contract', error.message); }
    }
  } catch (error) {
    add(browser ? 'browser_verification_failed' : 'browser_unavailable', error.message);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    if (browser) {
      const timer = setTimeout(stop, 2000);
      try { await browser.close(); } catch { stop(); } finally { clearTimeout(timer); }
    }
  }
  return { ok: errors.length === 0, errors, scope: requireAgentAction ? 'browser-agent-action-contract' : 'browser-startup', businessBehaviorVerified: false, layoutChecks, ...(actionVerification ? { agentAction: actionVerification } : {}),...(presentationVerification?{presentation:presentationVerification}:{}),...(inputVerification?{verificationInput:inputVerification}:{}) };
}

async function uploadPresentationVerificationInput(frame, fixture, settleMs) {
  await frame.evaluate(filename=>{
    const extension=filename.toLowerCase().endsWith('.csv')?'.csv':'.txt';
    const mimes=extension==='.csv'?['text/csv','application/csv','application/vnd.ms-excel']:['text/plain'];
    const candidates=[...document.querySelectorAll('input[type="file"]')].filter(input=>{
      if(input.disabled)return false;
      const accepts=input.accept.toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
      return !accepts.length||accepts.some(v=>v===extension||v==='*/*'||v==='text/*'||mimes.includes(v));
    });
    if(candidates.length!==1)throw Error('verificationInput requires exactly one enabled file input accepting its .txt or .csv type.');
    const input=candidates[0];
    const visible=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none';};
    const labels=[...input.labels||[]].filter(visible);
    const trigger=labels[0]||(visible(input)?input:undefined);
    if(!trigger)throw Error('Expose the verification file input or an associated visible label for the browser file chooser.');
    trigger.setAttribute('data-delivery-verification-trigger','true');
  },fixture.filename);
  const dir=await fs.mkdtemp(path.join(tmpdir(),'liveui-verification-input-'));
  try{
    const file=path.join(dir,fixture.filename);
    await fs.writeFile(file,fixture.content,{encoding:'utf8',mode:0o600});
    const [chooser]=await Promise.all([frame.page().waitForFileChooser({timeout:4000}),frame.click('[data-delivery-verification-trigger="true"]')]);
    await chooser.accept([file]);
    await new Promise(resolve=>setTimeout(resolve,Math.max(settleMs,350)));
    return{synthetic:true,uploaded:true,method:'file-chooser',filename:fixture.filename,bytes:Buffer.byteLength(fixture.content,'utf8')};
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}


// Neutral protocol fixtures, not application templates or generated business data.
function controlledPresentationTree(types, variant, token, context) {
  const rich = types.map(type => {
    const title = `${type} ${variant} ${token}`;
    if (type === 'Scene3D') return {type,scene:{title,grid:true,objects:[{id:`probe-${token}-${variant}`,shape:variant===1?'box':'torus',position:[0,0,0],scale:[1,1,1],color:variant===1?'#6366f1':'#10b981'}]}};
    if (type === 'Plot') return {type,plot:{title,kind:variant===1?'line':'bar',series:[{name:`Series ${variant}`,color:'#6366f1',points:variant===1?[[0,1],[1,3],[2,2]]:[[0,4],[1,1],[2,5]]}]}};
    return {type,diagram:{title,nodes:[{id:'a',label:`Start ${variant}`,x:.15,y:.25,color:'#6366f1'},{id:'b',label:`Result ${variant}`,x:.8,y:.7,color:'#10b981'},...(variant===2?[{id:'c',label:'Detail',x:.5,y:.45,color:'#f59e0b'}]:[])],edges:variant===1?[{from:'a',to:'b'}]:[{from:'a',to:'c'},{from:'c',to:'b'}]}};
  });
  const originals = [...(context.records||[]).map(r=>({type:'List',recordId:r.id,children:[]})),...(context.photos||[]).map(p=>({type:'Image',photoId:p.id}))];
  const marker={type:'Text',text:`delivery-tree-${token}-${variant}`};
  return variant===1
    ? {type:'Stack',children:[marker,{type:'Card',children:[{type:'Text',text:'First arrangement'},...rich,...originals]}]}
    : {type:'Grid',style:{columns:2},children:[{type:'Card',children:[marker,{type:'Text',text:'Reorganized content'}]},{type:'Stack',children:[...rich,...originals,{type:'Text',text:'Updated detail'}]}]};
}

async function presentationState(frame, marker, types) {
  await frame.waitForFunction(marker=>[...document.querySelectorAll('[data-liveui-component="Text"]')].some(n=>n.textContent===marker),{timeout:4000},marker);
  const state=await frame.evaluate(marker=>{
    const text=[...document.querySelectorAll('[data-liveui-component="Text"]')].find(n=>n.textContent===marker);
    let root=text;while(root.parentElement?.hasAttribute('data-liveui-component'))root=root.parentElement;
    root.scrollIntoView({block:'nearest'});
    const rect=root.getBoundingClientRect(),style=getComputedStyle(root);
    if(rect.width<160||rect.height<20||style.display==='none'||style.visibility==='hidden')throw Error('The returned component tree is not visibly rendered');
    const signature=n=>({type:n.dataset.liveuiComponent,children:[...n.children].filter(c=>c.hasAttribute('data-liveui-component')).map(signature)});
    return{rootType:root.dataset.liveuiComponent,structure:JSON.stringify(signature(root)),content:root.innerText};
  },marker);
  state.components=[];
  for(const type of types){
    const rendered=await frame.evaluate(async({marker,type})=>{
      const text=[...document.querySelectorAll('[data-liveui-component="Text"]')].find(n=>n.textContent===marker);
      let root=text;while(root.parentElement?.hasAttribute('data-liveui-component'))root=root.parentElement;
      const component=[...root.querySelectorAll('[data-liveui-component]')].find(n=>n.dataset.liveuiComponent===type);
      if(!component)throw Error(`The returned tree omitted ${type}`);
      const visual=component.querySelector(type==='Scene3D'?'section[data-renderer="webgl"] canvas':'svg');
      if(!visual)throw Error(`${type} needs its maintained ${type==='Scene3D'?'WebGL':'SVG'} renderer, not a label`);
      visual.scrollIntoView({block:'center'});
      const r=visual.getBoundingClientRect(),style=getComputedStyle(visual);
      if(r.width<160||r.height<100||r.bottom<=0||r.top>=innerHeight||style.display==='none'||style.visibility==='hidden')throw Error(`${type} is not visibly rendered`);
      let changed=0,width,height;
      if(type==='Scene3D'){
        const gl=visual.getContext('webgl');if(!gl||gl.isContextLost())throw Error('Scene3D has no live WebGL context');
        width=visual.width;height=visual.height;const pixels=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        for(let i=4;i<pixels.length;i+=4)if(Math.abs(pixels[i]-pixels[0])+Math.abs(pixels[i+1]-pixels[1])+Math.abs(pixels[i+2]-pixels[2])>20)changed++;
      }else{
        const marks=visual.querySelectorAll(type==='Plot'?'polyline,circle,rect':'g[role="button"] circle');
        if(marks.length<(type==='Plot'?3:2)||[...marks].some(n=>n.getBBox().width<=0||n.getBBox().height<=0))throw Error(`${type} has no plotted data or diagram nodes`);
        if(type==='Diagram'){
          const node=visual.querySelector('g[role="button"]');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));
          if(node.querySelector('circle')?.getAttribute('stroke-width')!=='4')throw Error('Diagram node interaction did not update its rendered selection');
        }
        const copy=visual.cloneNode(true);copy.setAttribute('width','640');copy.setAttribute('height','360');
        const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(copy));await image.decode();
        const canvas=document.createElement('canvas');canvas.width=width=640;canvas.height=height=360;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,width,height);
        const pixels=ctx.getImageData(0,0,width,height).data;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0)changed++;
      }
      if(changed<100)throw Error(`${type} must render nonempty graphics`);
      return{type,renderer:type==='Scene3D'?'webgl':'svg',pixelsChanged:changed,width,height};
    },{marker,type});
    state.components.push(rendered);
  }
  // Rich controls may add a selected-node caption. Compare the view after the
  // controlled interaction, not the earlier unselected caption.
  state.content=await frame.evaluate(marker=>{
    const text=[...document.querySelectorAll('[data-liveui-component="Text"]')].find(n=>n.textContent===marker);
    let root=text;while(root.parentElement?.hasAttribute('data-liveui-component'))root=root.parentElement;
    return root.innerText;
  },marker);
  return state;
}

async function verifyPresentation(frame,options){
  let currentFrame=frame,phase='controls',marker;
  try{
    return await verifyPresentationSteps(frame,{...options,setPhase:(value,expected)=>{phase=value;if(expected!==undefined)marker=expected;},restore:async()=>{currentFrame=await options.restore();return currentFrame;}});
  }catch(error){
    const snapshot=await currentFrame.evaluate(marker=>{
      const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
      const status=[...document.querySelectorAll('[role="status"],[role="alert"]')].filter(visible).map(n=>n.textContent.trim()).filter(Boolean).join(' | ').slice(0,350);
      const nodes=[...document.querySelectorAll('[data-liveui-component]')];
      const savedTreeKeys=[];
      if(marker)for(let i=0;i<Math.min(window.liveuiagent.storage.length,100);i++){const key=window.liveuiagent.storage.key(i),value=window.liveuiagent.storage.getItem(key);if(typeof value==='string'&&value.includes(marker))savedTreeKeys.push(String(key).slice(0,160));}
      return{status,generationCount:window.__deliveryUiGenerationCount(),renderCount:window.__deliveryUiRenderCount(),acknowledgedSaveCount:window.__deliveryUiSaveCount(),expectedMarkerPresent:Boolean(marker&&nodes.some(n=>n.dataset.liveuiComponent==='Text'&&n.textContent===marker)),savedTreeKeys:savedTreeKeys.slice(0,10),renderedComponentTypes:[...new Set(nodes.map(n=>n.dataset.liveuiComponent))].slice(0,10),renderedText:nodes.filter(n=>n.dataset.liveuiComponent==='Text').slice(0,3).map(n=>n.textContent.slice(0,120)).join(' | ').slice(0,240),generateButtonDisabled:Boolean(document.querySelector('[data-liveui-action="ui.generate"]')?.disabled)};
    },marker).catch(failure=>({captureError:String(failure.message).slice(0,200)}));
    const timeout=/Waiting failed:.*ms exceeded/i.test(error.message);
    const timeoutReason=phase==='fresh-frame-restore'?'Reopening did not display the last acknowledged generated tree.':phase==='failure-message'?'The failed generation did not display the actual host error.':phase==='failure-preservation'?'The failed generation did not retain the previous rendered tree.':'The expected presentation update was not observed.';
    const reason=timeout?timeoutReason:error.message;
    const failure=Error(`Presentation phase ${phase} failed: ${reason}`+(snapshot.status?' Visible status: '+snapshot.status.slice(0,180):'')+` Calls=${options.getCalls()}, generates=${snapshot.generationCount??'?'}, renders=${snapshot.renderCount??'?'}, expected tree visible=${snapshot.expectedMarkerPresent??'?'}.`+(snapshot.renderedText?' Rendered text: '+snapshot.renderedText.slice(0,100):''));
    failure.deliveryDiagnostic={phase,cause:String(error.message).slice(0,600),hostGenerationCalls:options.getCalls(),hostAcknowledgedWrites:options.getSaves().length,...snapshot};
    throw failure;
  }
}

async function verifyPresentationSteps(frame,{contract,token,error,setProbe,getCalls,getSaves,restore,setPhase}){
  await frame.evaluate(()=>{
    const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    if(document.querySelector('meta[name="liveui-ui-protocol"]')?.content!=='liveui-tree-v1')throw Error('Declare liveui-tree-v1 and render the returned tree with the maintained UI renderer.');
    const inputs=[...document.querySelectorAll('input[data-liveui-ui-request],textarea[data-liveui-ui-request]')].filter(visible);
    const buttons=[...document.querySelectorAll('button[data-liveui-action="ui.generate"],input[type="submit"][data-liveui-action="ui.generate"]')].filter(visible);
    if(inputs.length!==1||buttons.length!==1||buttons[0].disabled||inputs[0].disabled)throw Error('Provide one visible editable data-liveui-ui-request input and one enabled data-liveui-action="ui.generate" button, connected to await window.liveuiagent.ui.generate.');
    inputs[0].setAttribute('data-delivery-ui-input','true');buttons[0].setAttribute('data-delivery-ui-button','true');
  });
  const submit=async probe=>{
    await frame.$eval('[data-delivery-ui-input="true"]',(node,value)=>{const proto=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},probe.request);
    setProbe(probe);await frame.click('[data-delivery-ui-button="true"]');
  };
  const states=[];
  for(let variant=1;variant<=2;variant++){
    const previous=await frame.evaluate(()=>({generations:window.__deliveryUiGenerationCount(),saves:window.__deliveryUiSaveCount()}));
    const probe={variant,calls:0,request:`delivery-ui-${token}-${variant} generate a new ${contract.components.join(' and ')||'component'} layout`};
    setPhase(`variant-${variant}-submit`,`delivery-tree-${token}-${variant}`);
    await submit(probe);
    setPhase(`variant-${variant}-render`);
    let state;
    try{state=await presentationState(frame,`delivery-tree-${token}-${variant}`,contract.components);}
    catch(error){
      const diagnostic=await frame.evaluate(()=>({generations:window.__deliveryUiGenerationCount(),status:[...document.querySelectorAll('[role="status"],[role="alert"]')].filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}).map(n=>n.textContent.trim()).filter(Boolean).join(' | ').slice(0,350)}));
      if(diagnostic.generations===previous.generations)throw Error('The UI generation button did not invoke ui.generate.'+(diagnostic.status?' Visible status: '+diagnostic.status:'')+' If local upload is required first, provide synthetic app.json.verificationInput.');
      throw Error('UI generation did not render the returned component tree.'+(diagnostic.status?' Visible status: '+diagnostic.status:' '+error.message));
    }
    setPhase(`variant-${variant}-acknowledgement`);
    const counts=await frame.evaluate(()=>({generations:window.__deliveryUiGenerationCount(),saves:window.__deliveryUiSaveCount()}));
    if(probe.calls!==1||counts.generations!==previous.generations+1||counts.saves<=previous.saves||!probe.savedMarker)throw Error('Each UI submit must generate once and await host storage ACK before displaying the returned tree');
    if(!getSaves().some(save=>save.acknowledged&&save.value.includes(`delivery-tree-${token}-${variant}`)))throw Error('The generated tree was not acknowledged by host storage');
    states.push({variant,...state});setProbe(undefined);
  }
  setPhase('generation-diversity');
  if(states[0].structure===states[1].structure||states[0].content===states[1].content)throw Error('The two returned trees must change both visible structure and content, not only a preset theme');
  const writesBeforeFailure=new Map(getSaves().filter(save=>save.value.includes(`delivery-tree-${token}-2`)).map(save=>[save.key,save.value]));
  const generationsBeforeFailure=await frame.evaluate(()=>window.__deliveryUiGenerationCount());
  setPhase('failure-submit');
  await submit({variant:3,calls:0,failure:true,request:`delivery-ui-${token}-failure preserve the current view`});
  setPhase('failure-message');
  await frame.waitForFunction(error=>document.body.innerText.includes(error),{timeout:4000},error);
  setPhase('failure-preservation');
  const retained=await presentationState(frame,`delivery-tree-${token}-2`,contract.components);
  const latestWrites=new Map(getSaves().map(save=>[save.key,save.value]));
  const failedGenerations=await frame.evaluate(()=>window.__deliveryUiGenerationCount());
  if(failedGenerations!==generationsBeforeFailure+1)throw Error('The failed UI submit must still use ui.generate exactly once');
  if(retained.structure!==states[1].structure||retained.content!==states[1].content)throw Error('Generation failure must preserve the last rendered tree');
  setPhase('failure-storage');
  if([...writesBeforeFailure].some(([key,value])=>latestWrites.get(key)!==value))throw Error('Generation failure must preserve the last saved tree');
  setProbe(undefined);
  setPhase('fresh-frame-load');
  const callsBeforeRestore=getCalls();frame=await restore();
  setPhase('fresh-frame-restore');
  const reopened=await presentationState(frame,`delivery-tree-${token}-2`,contract.components);
  const restoredRenders=await frame.evaluate(()=>window.__deliveryUiRenderCount());
  if(restoredRenders<1||reopened.structure!==states[1].structure||reopened.content!==states[1].content||getCalls()!==callsBeforeRestore)throw Error('Reopening must restore the acknowledged tree through ui.render without generating another UI');
  return{frame,verification:{scope:'controlled-presentation-variants',generationCalls:getCalls(),successfulGenerations:2,failedGenerations:1,structureChanged:true,contentChanged:true,storageAcknowledgements:true,preservedViewOnError:true,restoredInFreshFrame:true,realProviderCalls:0,realBusinessCalls:0,variants:states}};
}

function installDeliverySdk(channel, agentEnabled, presentationEnabled, initialValues = {}) {
  const values = Object.assign(Object.create(null),initialValues), pending = new Map(); let sequence = 0, primaryAction = false, presentationAction = false;
  addEventListener('click', event => {
    if(event.isTrusted&&event.target.closest?.('[data-delivery-primary="true"]'))primaryAction=true;
    if(event.isTrusted&&event.target.closest?.('[data-delivery-ui-button="true"]'))presentationAction=true;
  }, true);
  const storage = { getItem: k => Object.hasOwn(values, String(k)) ? values[String(k)] : null, setItem: (k, v) => { values[String(k)] = String(v); }, removeItem: k => { delete values[k]; }, clear: () => { for (const k of Object.keys(values)) delete values[k]; }, key: i => Object.keys(values)[i] ?? null, get length() { return Object.keys(values).length; } };
  Object.defineProperty(window, 'localStorage', { value: storage });
  window.liveuiagent = { storage, ai: (prompt, context) => {
    if (!agentEnabled&&!(presentationEnabled&&context?.uiProtocol==='liveui-tree-v1')) return Promise.reject(Error('AI actions require a user action; unavailable during delivery startup verification'));
    const id = ++sequence;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); parent.postMessage({ channel, id, type: presentationEnabled&&context?.uiProtocol==='liveui-tree-v1'?'presentation':'agent', prompt, context, primaryAction, presentationAction }, '*'); });
  }, save:async(storageKey,value)=>{
    const id=++sequence;const ack=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});parent.postMessage({channel,id,type:'save',storageKey,value},'*');});
    storage.setItem(storageKey,value);return ack;
  }, download: () => { throw Error('Downloads require a user action during delivery verification'); } };
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel || event.data?.type !== 'agent-reply') return;
    const item = pending.get(event.data.id); if (!item) return; pending.delete(event.data.id);
    event.data.error ? item.reject(Error(event.data.error)) : item.resolve(event.data.value);
  });
  addEventListener('securitypolicyviolation', event => parent.postMessage({ channel, violation: 'Blocked ' + event.violatedDirective }, '*'));
}

async function verifyAgentAction(frame, request, serviceError, calls, beginAction, successEntities = null) {
  const binding = await frame.evaluate(() => {
    const visible = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const candidates = new Set(), hiddenControls = new Set();
    for (const node of document.querySelectorAll('[data-liveui-action="agent.invoke"]')) {
      // A form owns its real submit controls (including external form= controls),
      // not every preset/filter button that happens to sit inside it. An explicit
      // control binding remains primary even when its type is button.
      const controls = node instanceof HTMLFormElement
        ? [...node.elements].filter(control => control.form === node && ((control instanceof HTMLButtonElement && control.type === 'submit') || (control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type))))
        : [node];
      for (const control of controls) {
        if (control.matches('button,input[type="submit"],input[type="image"],input[type="button"]')) {
          if (visible(control)) candidates.add(control); else hiddenControls.add(control);
        }
      }
    }
    if (!candidates.size && hiddenControls.size) throw Error(`Found ${hiddenControls.size} bound primary action control(s), but all are hidden on initial open. Move the primary task form and submit button out of hidden tabs/panels, or make that panel initially visible. The real service workflow must be usable immediately without prior tab navigation.`);
    if (candidates.size !== 1) throw Error(`Expected one visible agent.invoke action after form/button deduplication; found ${candidates.size}. Mark the real primary form and submit button with data-liveui-action="agent.invoke".`);
    const button = [...candidates][0];
    const fields = [...(button.form ? button.form.elements : document.querySelectorAll('input,textarea'))].filter(node => visible(node) && !node.disabled);
    const textareas = fields.filter(node => node instanceof HTMLTextAreaElement);
    const textInputs = fields.filter(node => node instanceof HTMLInputElement && node.type === 'text');
    const named = [...textareas, ...textInputs].filter(node => /task|request|instruction|prompt/i.test([node.name,node.id,node.getAttribute('aria-label'),...(node.labels || [])].map(x => typeof x === 'string' ? x : x?.textContent || '').join(' ')));
    const choices = named.length === 1 ? named : textareas.length === 1 ? textareas : textInputs;
    if (choices.length !== 1) throw Error(`Expected one clear natural-language task input in the primary action form; found ${choices.length}. Keep it separate from secondary record-entry fields.`);
    button.setAttribute('data-delivery-primary', 'true'); choices[0].setAttribute('data-delivery-request', 'true');
    return { before: document.body.innerText, records: [...document.querySelectorAll('[data-liveui-view="records"]')].map(node => node.innerText), required: fields.filter(node => node.required && node !== choices[0]).map((node, i) => { node.setAttribute('data-delivery-required', String(i)); return { index:i, tag:node.tagName, type:node.type }; }) };
  });
  for (const field of binding.required) {
    const selector = `[data-delivery-required="${field.index}"]`;
    const node = await frame.$(selector);
    if (field.tag === 'SELECT') {
      const value = await node.evaluate(e => [...e.options].find(o => !o.disabled && o.value)?.value);
      if (value !== undefined) await node.select(value);
    } else if (['checkbox','radio'].includes(field.type)) { if (!await node.evaluate(e => e.checked)) await node.click(); }
    else if (field.type !== 'hidden') {
      const value = { number:'1', date:'2026-01-01', time:'12:00', email:'delivery@example.invalid', url:'https://example.invalid' }[field.type] || 'Delivery sample';
      await node.evaluate((e, value) => { e.value = value; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }, value);
    }
  }
  const input = await frame.$('[data-delivery-request="true"]');
  await input.click({ clickCount: 3 }); await input.press('Backspace'); await input.type(request);
  const button = await frame.$('[data-delivery-primary="true"]');
  if (await button.evaluate(node => node.disabled)) throw Error('The primary action stayed disabled after entering the current task; enable a usable submit control.');
  beginAction();
  await button.click();
  const deadline = Date.now() + 3500;
  let after = '';
  while (Date.now() < deadline) {
    after = await frame.evaluate(() => document.body.innerText);
    // Keep the whole bounded probe window open after the first rendered
    // response: a second async submit listener may call the SDK after it.
    if (calls.length > 1) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (calls.length > 1) throw Error(`Expected exactly one window.liveuiagent.ai invocation for one primary submit; observed ${calls.length}. Remove duplicate submit/click listeners, not domain behavior.`);
  if (!calls.length) throw Error('The primary user action did not call window.liveuiagent.ai. Wire its submit/click handler to await the host bridge; browser-only saves are not external service operations.');
  if (!calls.some(call => JSON.stringify(call).includes(request))) throw Error('The host call discarded the current natural-language input. Forward the complete entered request and fields in prompt/context.');
  if (successEntities) {
    if (!after.includes(serviceError)) throw Error('The host returned ok:true but its actual observed result was not visibly shown. Render the returned text/data rather than a local success placeholder.');
    await verifyDomainProjection(frame, successEntities);
    return {calls:calls.length,forwardedInput:true,displayedHostSuccess:true,scope:'synthetic-host-success',realServiceExecuted:false};
  }
  if (!after.includes(serviceError)) throw Error('The host returned ok:false but the actual error was not visibly shown. Render returned text/data.error and do not silently hide a failed service operation.');
  const recordsAfter = await frame.evaluate(() => [...document.querySelectorAll('[data-liveui-view="records"]')].map(node => node.innerText));
  if (JSON.stringify(recordsAfter) !== JSON.stringify(binding.records)) throw Error('The host returned ok:false but the domain records changed. Preserve prior observed records on failure.');
  const fresh = after.split('\n').map(line => line.trim()).filter(line => line && !binding.before.split('\n').map(x => x.trim()).includes(line));
  if (fresh.some(line => /^(success(?:ful(?:ly)?)?|saved|added|created|updated|done|completed)[.!]?$/i.test(line) || /\b(?:successfully (?:saved|added|created|updated)|(?:saved|added|created|updated) successfully|operation completed)\b/i.test(line))) throw Error('The host returned ok:false but the app displayed a success claim. Show the real error and do not mark external writes as successful.');
  return { calls: calls.length, forwardedInput: true, displayedHostError: true, scope:'synthetic-host-failure', realServiceExecuted:false };
}

// Inspect only designated domain record surfaces, never the generic host result.
async function verifyDomainProjection(frame, entities) {
  const missing = await frame.evaluate(entities => {
    const core = '#liveui-host-workflow,#liveui-task-result,#liveui-task-entities,#liveui-task-stats';
    const visible = node => {
      for (let e = node; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      }
      const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    };
    const texts = [...document.querySelectorAll('[data-liveui-view="records"]')]
      .filter(node => !node.matches('html,body') && !node.closest(core) && !node.querySelector(core) && visible(node))
      .map(node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const parts = []; let item;
        while ((item = walker.nextNode())) {
          const parent = item.parentElement;
          if (parent && !parent.closest(core) && !parent.closest('script,style,template') && visible(parent)) parts.push(item.textContent);
        }
        return parts.join(' ').replace(/\s+/g, ' ');
      });
    return entities.flatMap((entity, index) => ['name','detail','group'].filter(key => entity[key] != null && entity[key] !== '' && !texts.some(text => text.includes(String(entity[key]).replace(/\s+/g, ' ')))).map(key => `entity ${index + 1} ${key}`));
  }, entities);
  if (missing.length) throw Error('The host returned actual entities but the visible domain record surface omitted ' + missing.join(', ') + '. Render all returned name/detail/group in a data-liveui-view="records" collection outside the core host result. Keep unknown groups with a generic record fallback; do not require unpromised service fields.');
}


function measureDeliveryLayout() {
  const width = document.documentElement.clientWidth, height = innerHeight;
  const violations = [], nodes = [...document.body.querySelectorAll('*')];
  const leakedHidden = nodes.find(node => node.hasAttribute('hidden') && !(node.tagName === 'INPUT' && node.type === 'hidden') && getComputedStyle(node).display !== 'none');
  if (leakedHidden) violations.push(`Element ${leakedHidden.tagName.toLowerCase()}${leakedHidden.id ? '#'+leakedHidden.id : ''} has the hidden attribute but CSS overrides it with display:${getComputedStyle(leakedHidden).display}. Preserve hidden-state behavior, for example with [hidden]{display:none !important}; do not show collapsed editors or remove the hidden state.`);
  const shown = node => { const r=node.getBoundingClientRect(),s=getComputedStyle(node); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
  if (document.documentElement.scrollWidth > width + 3 || document.body.scrollWidth > width + 3)
    violations.push(`Horizontal page overflow: content ${Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}px exceeds iframe ${width}px. Wrap text and collapse columns; do not hide content.`);
  for (const node of nodes.filter(shown)) {
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName) && (rect.left < -3 || rect.right > width+3)) {
      violations.push(`Control ${node.tagName.toLowerCase()} extends outside iframe width. Make the control and its parent responsive.`); break;
    }
  }
  const oversized = nodes.filter(shown).find(node => {
    const text=[...node.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
    return text.length>=24 && parseFloat(getComputedStyle(node).fontSize)>64;
  });
  if(oversized) violations.push(`Long text uses ${getComputedStyle(oversized).fontSize} type. Use readable semantic heading/body sizes on every render path, including restored views.`);
  return {iframeWidth:width,iframeHeight:height,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),violations};
}

async function verifyExplicitDisclosures(frame) {
  // Only explicit disclosure buttons. Never submit, invoke a host action or
  // follow a link. Resolve again after each click: React may replace the DOM.
  const targets = await frame.evaluate(() => [...new Set([...document.querySelectorAll('[aria-expanded][aria-controls]')].map(n=>n.getAttribute('aria-controls')?.trim()).filter(t=>t&&!/\s/.test(t)))]);
  const violations=[];let checked=0;
  for(const target of targets) {
    const initial=await frame.evaluateHandle(resolveDisclosureControl,target),button=initial.asElement();
    if(!button){await initial.dispose();continue;}
    if(checked++>=3){await initial.dispose();break;}
    const expanded=await button.evaluate(n=>n.getAttribute('aria-expanded'));
    try {
      if(expanded==='true')await button.click();
      const result=await frame.evaluate(settleDisclosurePanel,target);
      const current=await frame.evaluateHandle(resolveDisclosureControl,target,false);
      const now=await current.asElement()?.evaluate(n=>n.getAttribute('aria-expanded'));
      await current.dispose();
      if(now!=='false')violations.push(`Disclosure for #${target} did not collapse after its explicit toggle.`);
      else if(!result.hidden)violations.push(`Disclosure for #${target} reports aria-expanded=false but its controlled panel remains visible (display:${result.display}, ${Math.round(result.width)}x${Math.round(result.height)}). Hide the controlled panel when collapsed and keep the toggle state consistent.`);
    } finally {
      if(expanded==='true') {
        const current=await frame.evaluateHandle(resolveDisclosureControl,target,false),restore=current.asElement();
        if(restore&&await restore.evaluate(n=>n.getAttribute('aria-expanded')==='false')) {
          await restore.click();await frame.evaluate(settleDisclosurePanel,target);
          const restored=await frame.evaluateHandle(resolveDisclosureControl,target);
          if(!restored.asElement()||!await restored.asElement().evaluate(n=>n.getAttribute('aria-expanded')==='true'))violations.push(`Disclosure for #${target} could not restore its original expanded control and panel.`);
          await restored.dispose();
        }
        await current.dispose();
      }
      await initial.dispose();
    }
  }
  return violations;
}
function resolveDisclosureControl(target, requireTarget=true) {
  const count=[...document.querySelectorAll('[id]')].filter(n=>n.id===target).length;
  if(count>1||(requireTarget&&count!==1))return null;
  const controls=[...document.querySelectorAll('[aria-expanded][aria-controls]')].filter(node=>{
    const role=node.getAttribute('role'),safeButton=node.tagName==='BUTTON'
      ? node.getAttribute('type')==='button'&&(!role||role==='button')
      : role==='button'&&node.tagName!=='INPUT'&&!node.hasAttribute('href');
    const r=node.getBoundingClientRect(),s=getComputedStyle(node);
    return safeButton&&node.getAttribute('aria-controls')?.trim()===target&&/^(true|false)$/.test(node.getAttribute('aria-expanded'))&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!node.closest('[data-liveui-action]')&&!node.disabled&&node.getAttribute('aria-disabled')!=='true';
  });
  return controls.length===1?controls[0]:null;
}
async function settleDisclosurePanel(target) {
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const panel=document.getElementById(target);
  if(!panel)return {hidden:true};
  const animations=panel.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming()?.endTime));
  await Promise.all(animations.map(a=>a.finished.catch(()=>{})));
  const r=panel.getBoundingClientRect(),s=getComputedStyle(panel);
  return {hidden:s.display==='none'||s.visibility==='hidden'||s.contentVisibility==='hidden'||s.opacity==='0'||(parseFloat(s.maxHeight)===0&&['hidden','clip'].includes(s.overflowY))||r.width===0||r.height===0||panel.getClientRects().length===0,display:s.display,width:r.width,height:r.height};
}
