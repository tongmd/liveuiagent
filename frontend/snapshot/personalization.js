(() => {
  const api=async(path,method='GET',body)=>{const r=await fetch(window.__liveuiPath('/agent/personal'+path),{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Save failed');return data;};
  let state, panel, status, currentTab='memory';
  window.__personalReady=api('').then(s=>window.__personalState=state=s).catch(()=>window.__personalState=state={layout:{},appearances:{},memories:[],apps:[],enabledShared:[],hidden:[]});
  window.__personalSaveMaterialLayout=layout=>{api('/material-layout','PUT',{layout}).then(()=>{state.materialLayout=layout}).catch(e=>notify(e.message));};
  window.__personalSaveLayout=layout=>{api('/layout','PUT',{layout}).then(()=>{state.layout=layout}).catch(e=>notify(e.message));};
  function notify(message){if(status){status.textContent=message;return;}const el=document.createElement('div');el.className='personal-toast';el.setAttribute('role','status');el.textContent=message;document.body.append(el);setTimeout(()=>el.remove(),4500);}
  function element(tag,props={},children=[]){const e=document.createElement(tag);for(const [k,v] of Object.entries(props)){if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else if(k==='text')e.textContent=v;else if(k==='class')e.className=v;else e.setAttribute(k,v);}e.append(...children);return e;}
  const button=(label,fn)=>element('button',{type:'button',text:label,onclick:fn});
  function field(label,input){return element('label',{class:'personal-field'},[element('span',{text:label}),input]);}
  function appSelect(global=false){const s=element('select',{'aria-label':global?'Memory scope':'Select app'});if(global)s.append(element('option',{value:'global',text:'All apps, including future apps'}));for(const a of state.apps)s.append(element('option',{value:a.appId,text:a.name}));return s;}
  function apply(){
    for(const node of document.querySelectorAll('[data-app-id]')){
      const p=state.appearances[node.dataset.appId];node.classList.toggle('personal-styled',!!p);
      if(!p){node.removeAttribute('data-personal-layout');continue;}
      node.dataset.personalLayout=p.layout;node.dataset.personalDensity=p.density;
      const vars={'--personal-bg':p.background,'--personal-surface':p.surface,'--personal-text':p.text,'--personal-accent':p.accent,'--personal-radius':p.radius+'px','--personal-font':p.font==='serif'?'Georgia, "Noto Serif SC", serif':p.font==='mono'?'ui-monospace, monospace':'system-ui, sans-serif'};
      for(const [k,v] of Object.entries(vars))if(node.style.getPropertyValue(k)!==v)node.style.setProperty(k,v);
    }
  }
  function close(){panel?.remove();panel=null;status=null;document.querySelector('.personal-space-button')?.focus();}
  function open(tab=currentTab){currentTab=tab;panel?.remove();panel=element('section',{class:'personal-panel',role:'dialog','aria-modal':'true','aria-label':'Memory'});status=element('p',{class:'personal-status',role:'status'});
    const head=element('div',{class:'personal-head'},[element('div',{},[element('h2',{text:'Memory'})]),button('Close',close)]);
    const tabs=element('nav',{'aria-label':'Memory settings'},[['library','Apps'],['memory','Memories']].map(([id,name])=>{const b=button(name,()=>open(id));b.setAttribute('aria-current',String(id===tab));return b;}));
    const content=element('div',{class:'personal-content'});panel.append(head,tabs,content,status);document.body.append(panel);
    if(tab==='memory')renderMemory(content);if(tab==='library')renderLibrary(content);
    panel.querySelector('button')?.focus();
  }
  function renderMemory(root){
    root.append(element('p',{text:'Preferences shared while using your apps are saved here with their context. You can edit or delete them at any time.'}));
    const automatic=element('input',{type:'checkbox','aria-label':'Remember preferences as I use apps'});automatic.checked=state.contextualEnabled!==false;
    automatic.onchange=async()=>{try{const r=await api('/context-settings','PUT',{enabled:automatic.checked});state.contextualEnabled=r.enabled;}catch(e){automatic.checked=!automatic.checked;notify(e.message)}};
    root.append(field('Remember preferences as I use apps',automatic));
    const list=element('div',{class:'personal-memory-list'});
    if(!state.memories.length)list.append(element('p',{class:'personal-muted',text:'No memories yet. Share a preference while using or editing an app to get started.'}));
    for(const m of state.memories){
      const scope=m.scope==='global'?'Used when relevant':state.apps.find(a=>a.appId===m.scope)?.name||'This app';
      const item=element('article',{class:'personal-memory'},[element('small',{text:scope+' · '+(m.active?'Active':'Expired')}),element('p',{text:m.content}),...(m.condition?[element('p',{class:'personal-muted',text:'Context: '+m.condition})]:[])]);
      const edit=button('Edit',()=>{
        const content=element('textarea',{rows:3,maxlength:1200,'aria-label':'Edit saved preference'});content.value=m.content;
        const condition=element('textarea',{rows:2,maxlength:400,'aria-label':'Edit context'});condition.value=m.condition||'';
        const editor=element('div',{class:'personal-memory-editor'},[field('Content',content),...(m.source==='interaction'?[field('Context',condition)]:[])]);
        editor.append(button('Save changes',async()=>{try{const out=await api('/memory','PUT',{id:m.id,content:content.value,scope:m.scope,...(m.source==='interaction'?{condition:condition.value}:{}),expiresAt:m.expiresAt||null});state.memories=out.memories;open('memory');}catch(e){notify(e.message)}}),button('Cancel',()=>open('memory')));item.replaceChildren(editor);content.focus();
      });
      item.append(element('div',{class:'personal-actions'},[edit,button('Delete',async()=>{try{await api('/memory/'+encodeURIComponent(m.id),'DELETE');state.memories=state.memories.filter(x=>x.id!==m.id);open('memory')}catch(e){notify(e.message)}})]));list.append(item);
    }
    root.append(list);
  }
  function renderLibrary(root){root.append(element('p',{text:'Choose the apps shown on your workspace. Hiding an app keeps its data.'}));const checks=[];for(const a of state.apps){const input=element('input',{type:'checkbox','aria-label':a.name});input.checked=!state.hidden.includes(a.appId)&&(!a.shared||state.enabledShared.includes(a.appId));checks.push([a.appId,input]);root.append(element('label',{class:'personal-library-item'},[input,element('span',{},[element('strong',{text:a.name}),element('small',{text:a.description})])]));}
    root.append(button('Save app visibility',async()=>{try{await api('/library','PUT',{visible:checks.filter(([id,c])=>c.checked).map(([id])=>id)});location.reload()}catch(e){notify(e.message)}}));}
  window.__personalReady.then(()=>{const mount=()=>{document.body.append(element('button',{class:'personal-space-button',type:'button',text:'Memory',onclick:async()=>{try{state=await api('');window.__personalState=state;open()}catch(e){notify(e.message)}}}));
      let refreshing=false;
      const syncNewApps=async()=>{if(refreshing||!state.apps?.length)return;const known=new Set(state.apps.map(a=>a.appId));if(![...document.querySelectorAll('[data-app-id]')].some(n=>n.dataset.appId&&!known.has(n.dataset.appId)))return;refreshing=true;try{state=await api('');window.__personalState=state;apply()}catch{}finally{refreshing=false}};
      const obs=new MutationObserver(()=>{apply();syncNewApps()});obs.observe(document.body,{childList:true,subtree:true});apply();
      document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel)close();if(e.key==='Tab'&&panel){const nodes=[...panel.querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});};document.readyState==='loading'?document.addEventListener('DOMContentLoaded',mount):mount();});
})();
