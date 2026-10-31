(() => {
  const stages = {'等待开始':'Queued','DSH 正在理解需求':'DSH is preparing your app','任务完成':'Complete','应用已更新':'App updated','本次任务未完成':'Task failed','服务已停止':'Service stopped','服务重启，请重新提交':'Service restarted. Please submit again.'};
  const stageLabel = value => stages[value] || (/[\u3400-\u9fff]/.test(value || '') ? 'Working…' : value || 'Working…');
  const api=async(route,method='GET',body,signal)=>{const path='/agent/complete/'+route;let r;try{r=await fetch(window.__liveuiPath?window.__liveuiPath(path):path,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),...(signal?{signal}:{})});}catch(error){throw Object.assign(error,{transport:true});}let d;try{d=await r.json();}catch(error){if(!r.ok)throw Object.assign(Error('Request failed ('+r.status+')'),{status:r.status});if(error?.name==='TypeError')throw Object.assign(error,{transport:true});throw error;}if(!r.ok)throw Object.assign(Error(d.error||'Request failed'),{status:r.status});if(method!=='GET'||route.startsWith('jobs/')&&!['queued','running'].includes(d.status))window.__liveuiActivityRefresh?.();return d;};
  const channel=()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),x=>x.toString(16).padStart(2,'0')).join('');
  function bootstrap(initial,key){
    const values=Object.assign(Object.create(null),initial),pending=new Map(),touched=new Set();let seq=0,saving=false;
    function request(type,payload){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Request timed out. Please try again.'));},930000);pending.set(id,{resolve,reject,timer});parent.postMessage({channel:key,id,type,...payload},'*');});}
    addEventListener('message',e=>{if(e.source!==parent||e.data?.channel!==key||e.data?.type!=='reply')return;const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);clearTimeout(p.timer);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.value);});
    const storage={getItem(k){return Object.hasOwn(values,String(k))?values[String(k)]:null;},setItem(k,v){if(saving)throw Error('Wait for saving to finish');values[String(k)]=String(v);request('store',{store:values}).catch(e=>console.error(e.message));},removeItem(k){if(saving)throw Error('Wait for saving to finish');delete values[String(k)];request('store',{store:values}).catch(e=>console.error(e.message));},clear(){if(saving)throw Error('Wait for saving to finish');for(const k of Object.keys(values))delete values[k];request('store',{store:values}).catch(e=>console.error(e.message));},key(i){return Object.keys(values)[i]||null;},get length(){return Object.keys(values).length;}};
    Object.defineProperty(window,'localStorage',{value:storage});
    function capture(){const fields=[...touched].filter(e=>e.isConnected&&e.value?.trim()).map(e=>({label:e.labels?.[0]?.textContent||e.getAttribute('aria-label')||e.name||e.id||'Text input',value:e.value.slice(0,2000)}));touched.clear();if(fields.length)request('interaction',{fields}).catch(()=>{});}
    document.addEventListener('input',e=>{const x=e.target;if(e.isTrusted&&(x.matches('textarea')||x.matches('input[type="text"],input:not([type])'))&&!/password|secret|token|api.?key/i.test(x.name+' '+x.id+' '+x.autocomplete))touched.add(x);},true);
    document.addEventListener('submit',capture,true);
    // Re-measure existing auto-sized fields after iframe layout/restore settles.
    if(typeof ResizeObserver==='function')document.addEventListener('DOMContentLoaded',()=>{
      let scheduled=false;const fit=()=>{scheduled=false;for(const x of document.querySelectorAll('textarea')){const style=getComputedStyle(x);if(!x.value||!x.style.height||style.resize!=='none'||!x.clientHeight)continue;const cap=Math.min(innerHeight/3,parseFloat(style.maxHeight)||Infinity);if(x.scrollHeight>x.clientHeight+2&&x.clientHeight<cap)x.style.height=Math.min(cap,x.scrollHeight+2)+'px';}};
      const queue=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(fit);}};
      const observer=new ResizeObserver(queue);observer.observe(document.documentElement);for(const x of document.querySelectorAll('textarea'))observer.observe(x);queue();
    },{once:true});
    window.liveuiagent={storage,async save(k,v){if(saving)throw Error('Wait for saving to finish');saving=true;try{const candidate=Object.assign(Object.create(null),values,{[String(k)]:String(v)});await request('store',{store:candidate,expected:JSON.parse(JSON.stringify(values))});values[String(k)]=String(v);return {ok:true};}finally{saving=false;}},ai(prompt,context){capture();return request('ai',{prompt,context});},download(filename,content,mimeType='text/plain;charset=utf-8'){const u=URL.createObjectURL(new Blob([content],{type:mimeType})),a=document.createElement('a');a.href=u;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);}};
  }
  function documentFor(html,store,key){
    const policy='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    const insertion=policy+'<script>('+bootstrap.toString()+')('+JSON.stringify(store).replace(/</g,'\\u003c')+','+JSON.stringify(key)+');'+(window.__liveuiStructuredRuntime?'window.liveuiagent.ui=('+window.__liveuiStructuredRuntime.toString()+')(window.liveuiagent);':'')+'<\/script>';
    return /<head[^>]*>/i.test(html)?html.replace(/<head[^>]*>/i,m=>m+insertion):insertion+html;
  }
  window.LiveUIAgentCompleteApp=function({app}){
    const R=window.__liveuiagentReact,h=R.createElement,[data,setData]=R.useState(null),[status,setStatus]=R.useState('Opening…'),[prompt,setPrompt]=R.useState(''),[job,setJob]=R.useState(null),frame=R.useRef(null),key=R.useRef(channel()),writes=R.useRef(Promise.resolve()),alive=R.useRef(true),jobRef=R.useRef(null);
    const appId=app.appId,chinese=/[\u3400-\u9fff]/.test(app.name||'');
    const [loadError,setLoadError]=R.useState(false);
    const load=async()=>{setLoadError(false);try{const d=await api('apps/'+appId);if(!alive.current)return;key.current=channel();setData(d);setStatus('');}catch(error){if(alive.current)setLoadError(true);throw error;}};
    const wait=async(id,expectedChannel=key.current,pollMs=2000)=>{const deadline=Date.now()+900000;let failures=0;const unconfirmed=cause=>{if(key.current!==expectedChannel)throw Error('The application view changed; the original task remains available by ID');const failure=Object.assign(Error('Task '+id+' status is unconfirmed. It was not resubmitted. '+cause),{jobUnconfirmed:true,jobId:id});jobRef.current={...(jobRef.current||{}),id,statusUnconfirmed:true};if(alive.current){setStatus(failure.message);setJob({...jobRef.current,stage:failure.message});}return failure;};for(;;){if(key.current!==expectedChannel)throw Error('The application view changed; the original task remains available by ID');if(Date.now()>=deadline)throw unconfirmed('Polling time limit reached.');let j;try{j=await api('jobs/'+id,'GET',undefined,AbortSignal.timeout(Math.max(1,deadline-Date.now())));failures=0;}catch(error){const recoverable=error.transport||[502,503,504].includes(error.status);if(!recoverable)throw error;if(++failures>=6||Date.now()>=deadline)throw unconfirmed(error.message);await new Promise(r=>setTimeout(r,Math.min(2000,Math.max(0,deadline-Date.now()))));continue;}if(!['queued','running'].includes(j.status)){if(j.status!=='done')throw Error(j.error||'Task cancelled');return j;}if(alive.current){setStatus(stageLabel(j.stage));setJob(j);}await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(0,deadline-Date.now()))));}};
    R.useEffect(()=>{alive.current=true;load().catch(e=>setStatus(e.message));return()=>{alive.current=false;};},[appId]);
    R.useEffect(()=>{
      const handler=async e=>{
        if(e.source!==frame.current?.contentWindow||e.data?.channel!==key.current)return;
        const {id,type,channel:ch}=e.data,source=e.source;let ownsJob=false;const reply=(value,error)=>source.postMessage({channel:ch,type:'reply',id,value,error},'*');
        try{
          if(type==='store'){
            if(!e.data.store||Array.isArray(e.data.store)||JSON.stringify(e.data.store).length>1000000)throw Error('Data is too large');
            const snapshot=e.data.store;setStatus('Saving…');const write=writes.current.catch(()=>{}).then(()=>e.data.expected?api('apps/'+appId+'/store-commit','POST',{store:snapshot,expected:e.data.expected}):api('apps/'+appId+'/store','PUT',snapshot));writes.current=write;await write;if(alive.current)setStatus('Saved');reply({ok:true});
          }else if(type==='interaction'){
            await api('apps/'+appId+'/interaction','POST',{fields:e.data.fields});reply({ok:true});
          }else if(type==='ai'){
            if(jobRef.current)throw Error('Wait for the current task to finish');
            ownsJob=true;jobRef.current={pending:true};setJob({stage:'Generating…'});const j=await api('apps/'+appId+'/action','POST',{prompt:e.data.prompt,context:e.data.context??{}});if(key.current!==ch){reply(null,'The application view changed; task '+j.id+' remains available');return;}jobRef.current=j;setJob(j);const result=j.status==='done'?j:await wait(j.id,ch,j.execution?.actionRuntime==='structured-ui'?250:2000);reply(result.result);if(key.current!==ch)return;jobRef.current=null;if(alive.current){setJob(null);setStatus('');}
          }
        }catch(err){reply(null,err.message);if(alive.current&&key.current===ch){setStatus(err.message);if(type==='ai'&&ownsJob&&key.current===ch&&!err.jobUnconfirmed){jobRef.current=null;setJob(null);}}}
      };
      addEventListener('message',handler);return()=>removeEventListener('message',handler);
    },[appId]);
    const revise=async e=>{e.preventDefault();if(!prompt.trim()||jobRef.current)return;setStatus('Preparing changes…');jobRef.current={pending:true};setJob({stage:'Preparing changes…'});try{await writes.current;const j=await api('apps/'+appId+'/revise','POST',{prompt,displayEnvironment:{browserViewport:{width:innerWidth,height:innerHeight},appViewport:frame.current?{width:frame.current.clientWidth,height:frame.current.clientHeight}:null}});jobRef.current=j;setJob(j);await wait(j.id);setPrompt('');await load();window.__liveuiagentRefresh?.();}catch(err){setStatus(err.message);}finally{if(!jobRef.current?.statusUnconfirmed){jobRef.current=null;setJob(null);}}};
    const download=()=>{const u=URL.createObjectURL(new Blob([data.html],{type:'text/html;charset=utf-8'})),a=document.createElement('a');a.href=u;a.download=app.name+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(u),10000);};
    const src=R.useMemo(()=>data?documentFor(data.html,data.store,key.current):'', [data]);
    return h('div',{className:'complete-app-host','data-loading':String(!data)},
      h('div',{className:'complete-app-actions'},h('small',null,job?stageLabel(job.stage):status||''),h('div',null,h('button',{type:'button',onClick:()=>load().catch(e=>setStatus(e.message)),disabled:!!job,title:chinese?'重新打开':'Reopen','aria-label':chinese?'重新打开':'Reopen'},'↻'),h('button',{type:'button',onClick:download,disabled:!data},chinese?'导出':'Export ↗'),job?.id&&job?.execution?.actionRuntime!=='structured-ui'?h('button',{type:'button',onClick:()=>api('jobs/'+job.id,'DELETE').catch(e=>setStatus(e.message))},'Cancel task'):null)),
      data?h('iframe',{ref:frame,title:app.name,className:'complete-app-frame',sandbox:'allow-scripts allow-forms allow-modals allow-downloads',referrerPolicy:'no-referrer',srcDoc:src}):h('div',{role:'status',className:loadError?'ulemi-app-opening-error':'ulemi-app-loading'},h('span',null,status),loadError?h('button',{type:'button',onClick:()=>load().catch(e=>setStatus(e.message))},chinese?'重新打开':'Retry'):null),
      h('form',{className:'complete-app-edit',onSubmit:revise},h('textarea',{rows:1,maxLength:16000,value:prompt,onChange:e=>setPrompt(e.target.value),placeholder:chinese?'调整这个应用…':'Change this app…','aria-label':'Edit this app'}),h('button',{type:'submit',disabled:!!job||!prompt.trim()},job?(chinese?'处理中…':'Working…'):(chinese?'更新':'Update')))
    );
  };
})();
