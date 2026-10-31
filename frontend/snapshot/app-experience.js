/* One app surface, with explicit per-app executor selection. No automatic request retries. */
(() => {
  'use strict';
  const doc = document.documentElement;
  const endpoint = path => window.__liveuiPath ? window.__liveuiPath(path) : `${location.pathname.startsWith('/liveui') ? '/liveui' : ''}${path}`;
  const nativeShell = () => /UlemiMobile\/1/.test(navigator.userAgent) || doc.dataset.ulemiShell === 'true';
  const zh = element => element?.dataset.appName ? /[\u3400-\u9fff]/.test(element.dataset.appName) : !/^en\b/i.test(navigator.language || '');
  const labels = (sheet,cn,en) => zh(sheet) ? cn : en;
  const node = (tag,cls,text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
  let scheduled=false,menu=null;
  const viewport = () => {
    const v=window.visualViewport;
    doc.style.setProperty('--ulemi-view-height',Math.round(v?.height || innerHeight)+'px');
    doc.style.setProperty('--ulemi-view-top',Math.round(v?.offsetTop || 0)+'px');
    document.body.classList.toggle('ulemi-keyboard-open',innerHeight-(v?.height || innerHeight)>120);
  };
  async function api(path,method='GET',body){
    const r=await fetch(endpoint(path),{method,credentials:'same-origin',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    const value=await r.json().catch(()=>({}));
    if(!r.ok)throw Object.assign(Error(value.error || `Request failed (${r.status})`),{status:r.status,code:value.code});
    return value;
  }
  function button(text,fn,cls){const b=node('button',cls,text);b.type='button';b.addEventListener('click',fn);b.addEventListener('pointerdown',e=>e.stopPropagation());return b;}
  function openHarness(sheet,trigger){
    if(document.querySelector('.ulemi-harness-dialog'))return;
    const id=sheet.dataset.appId,route='/agent/apps/'+encodeURIComponent(id)+'/harness';
    const dialog=node('dialog','ulemi-harness-dialog'),header=node('header'),title=node('h2','',labels(sheet,'应用 Agent','App agent'));
    title.id='ulemi-harness-title';dialog.setAttribute('aria-labelledby',title.id);
    const close=()=>{if(!pending)dialog.close();};header.append(title,button('×',close));header.lastChild.setAttribute('aria-label',labels(sheet,'关闭','Close'));
    const info=node('p','',labels(sheet,'仅更换这个应用的 Agent，现有内容和数据保留。','Change the agent for this app. Its content and data stay in place.'));
    const agentLabel=node('label','',labels(sheet,'Agent','Agent')),agents=node('select');agents.setAttribute('aria-label','App agent');agentLabel.append(agents);
    const modelLabel=node('label','',labels(sheet,'模型','Model')),models=node('select');models.setAttribute('aria-label','App model');modelLabel.append(models);
    const status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const footer=node('div','ulemi-harness-actions'),cancel=button(labels(sheet,'取消','Cancel'),close),submit=button(labels(sheet,'切换','Switch'),change,'primary');footer.append(cancel,submit);
    const memory=document.querySelector('.personal-space-button');if(memory){const openMemory=button(labels(sheet,'记忆','Memory'),()=>{if(pending)return;dialog.close();memory.click();});footer.prepend(openMemory);}
    dialog.append(header,info,agentLabel,modelLabel,status,footer);document.body.append(dialog);
    let state=null,pending=false;
    const message=(text,error=false)=>{status.textContent=text;status.classList.toggle('is-error',error);};
    const available=()=>state?.choices?.find(x=>x.id===agents.value);
    const updateSubmit=()=>{const choice=available();submit.disabled=pending||!choice?.available||!!state?.busy||!models.value||(agents.value===state?.harness&&models.value===state?.model);};
    const updateModels=()=>{const choice=available();models.replaceChildren();for(const value of [...new Set([choice?.model,...(choice?.models || [])].filter(Boolean))]){const o=node('option','',value);o.value=value;models.append(o);}models.value=agents.value===state?.harness&&[...models.options].some(o=>o.value===state.model)?state.model:choice?.model || models.options[0]?.value || '';models.disabled=pending||models.options.length<2;updateSubmit();};
    async function read(){
      agents.disabled=true;submit.disabled=true;message(labels(sheet,'正在读取…','Loading…'));
      try{state=await api(route);if(!dialog.isConnected)return;agents.replaceChildren();for(const choice of state.choices || []){const o=node('option','',choice.label || choice.id);o.value=choice.id;o.disabled=!choice.available;agents.append(o);}agents.value=state.harness;agents.disabled=pending||state.busy||!state.choices?.some(x=>x.available&&x.id!==state.harness);updateModels();message(state.busy?labels(sheet,'当前任务完成后可以切换。','Switch after the current task finishes.'):state.format==='html'?labels(sheet,'此应用使用 DSH。','This app uses DSH.'):'' );}
      catch(error){message(error.message,true);}
    }
    async function change(){
      if(pending||!state||submit.disabled)return;
      const target={harness:agents.value,model:models.value,expectedToken:state.token};pending=true;agents.disabled=true;models.disabled=true;submit.disabled=true;cancel.disabled=true;
      message(labels(sheet,'正在切换…','Switching…'));
      try{
        const result=await api(route,'PATCH',target);
        await window.__ulemiReloadAppBinding?.(id,result);
        window.dispatchEvent(new CustomEvent('ulemi:harness-changed',{detail:{appId:id,binding:result}}));
        await window.__liveuiagentRefresh?.();
        trigger.dataset.harness=result.harness;trigger.title=result.harness;
        message(labels(sheet,'已切换，内容已保留。','Switched. Content preserved.'));submit.textContent=labels(sheet,'已切换','Switched');
        state=result;pending=false;cancel.disabled=false;cancel.textContent=labels(sheet,'完成','Done');agents.disabled=false;updateModels();
      }catch(error){
        // PATCH may have committed before a transport loss. Only read back; never repeat it.
        pending=false;cancel.disabled=false;await read();
        try{await window.__ulemiReloadAppBinding?.(id,state);}catch{}
        message(labels(sheet,'未确认切换完成。已重新读取当前设置，请检查后再操作。','The switch was not confirmed. Current settings were reloaded; check them before trying again.')+' '+error.message,true);
      }
    }
    agents.addEventListener('change',updateModels);models.addEventListener('change',updateSubmit);
    dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
    dialog.addEventListener('close',()=>{dialog.remove();if(trigger.isConnected)trigger.focus();},{once:true});
    dialog.showModal();void read();
  }
  async function runNative(sheet,prompt,feedback){
    const id=sheet.dataset.appId,requestId=crypto.randomUUID();
    const response=await fetch(endpoint('/agent/run'),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({prompt,selectedAppId:id,clientRequestId:requestId,platform:'web',displayEnvironment:{browserViewport:{width:innerWidth,height:innerHeight},appViewport:{width:sheet.clientWidth,height:sheet.clientHeight}}})});
    let result=null;
    if((response.headers.get('content-type') || '').includes('text/event-stream')){
      if(!response.body)throw Error('No response stream');const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){const part=await reader.read();buffer+=decoder.decode(part.value || new Uint8Array(),{stream:!part.done});const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop();for(const block of blocks){const event=block.match(/^event:\s*(.+)$/m)?.[1];const raw=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!raw)continue;const value=JSON.parse(raw);if(event==='progress')feedback.textContent=value.step || labels(sheet,'正在修改…','Updating…');if(event==='error')throw Error(value.error || 'Update failed');if(event==='result')result=value;}if(part.done)break;}
    }else{result=await response.json();if(!response.ok)throw Error(result.error || `Request failed (${response.status})`);}
    if(!result)throw Error(labels(sheet,'连接已中断，请先查看任务状态；原需求未自动重发。','Connection interrupted. Check task status; the request was not resubmitted.'));
    if(result.type==='needs_confirmation')throw Error(result.report?.reason || labels(sheet,'此修改需要确认。','This change needs confirmation.'));
    if(!['app_patched','answered','state'].includes(result.type))throw Error(labels(sheet,'未收到应用修改结果，请查看任务状态。','No app update was confirmed. Check task status.'));
    if(result.type==='app_patched'&&result.appPackage?.manifest?.appId!==id)throw Error('The result belongs to another app. Check task status.');
    await window.__liveuiagentRefresh?.();window.__liveuiActivityRefresh?.();
    feedback.textContent=result.type==='app_patched'?labels(sheet,'已更新','Updated'):result.answer||result.summary?.text||labels(sheet,'已收到回复，应用尚未确认修改。','Reply received. An app change was not confirmed.');
  }
  function nativeComposer(sheet){
    if(sheet.querySelector('.complete-app-host,.ulemi-native-compose'))return;
    const feedback=node('div','ulemi-native-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    const form=node('form','ulemi-native-compose'),input=node('textarea'),send=node('button','',labels(sheet,'发送','Send'));
    input.rows=1;input.maxLength=12000;input.placeholder=labels(sheet,'调整这个应用…','Change this app…');input.setAttribute('aria-label',labels(sheet,'调整这个应用','Change this app'));send.type='submit';send.disabled=true;
    let pending=false;input.addEventListener('input',()=>{send.disabled=pending||!input.value.trim();input.style.height='44px';input.style.height=Math.min(112,input.scrollHeight)+'px';});
    form.addEventListener('submit',async e=>{e.preventDefault();const prompt=input.value.trim();if(!prompt||pending)return;pending=true;send.disabled=true;feedback.textContent=labels(sheet,'正在修改…','Updating…');sheet.dataset.ulemiSubmitting='true';
      try{await runNative(sheet,prompt,feedback);if(input.value.trim()===prompt){input.value='';input.style.height='44px';}}
      catch(error){feedback.textContent=error.message;}
      finally{pending=false;delete sheet.dataset.ulemiSubmitting;send.disabled=!input.value.trim();}
    });form.append(input,send);sheet.append(feedback,form);
  }
  function synchronize(){
    scheduled=false;viewport();
    const sheets=[...document.querySelectorAll('.app-sheet')],active=sheets.at(-1);
    document.body.classList.toggle('ulemi-app-open',!!active);
    for(const sheet of sheets){
      const background=sheet!==active;sheet.dataset.ulemiBackground=String(background);
      const phone=innerWidth<=700;if(phone&&background){sheet.inert=true;sheet.dataset.ulemiInert='true';}else if(sheet.dataset.ulemiInert){sheet.inert=false;delete sheet.dataset.ulemiInert;}
      const header=sheet.querySelector('.sheet-header');if(!header)continue;
      let tools=header.querySelector('.ulemi-window-tools');if(!tools){tools=node('div','ulemi-window-tools');const agent=button('Agent',()=>openHarness(sheet,agent),'ulemi-agent-button');agent.setAttribute('aria-label',labels(sheet,'切换应用 Agent','Change app agent'));tools.append(agent);header.insertBefore(tools,header.querySelector('.sheet-close'));}
      nativeComposer(sheet);
    }
    if(nativeShell()){
      doc.dataset.ulemiShell='true';
      if(!menu){menu=button('☰',()=>window.prompt('__ulemi_menu_v1__'),'ulemi-native-menu');menu.dataset.ulemiNativeMenu='true';menu.setAttribute('aria-label','Ulemi menu');}
      const target=active?.querySelector('.ulemi-window-tools') || document.body;
      menu.classList.toggle('home-menu',!active);if(menu.parentNode!==target)target.append(menu);
    }
  }
  const queue=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(synchronize);}};
  const init=()=>{new MutationObserver(queue).observe(document.body,{childList:true,subtree:true});window.addEventListener('resize',queue);window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);queue();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
