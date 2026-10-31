(() => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const workspaceLocale = snapshot => /[\u3400-\u9fff]/.test(snapshot?.lastRequest || snapshot?.app?.name || snapshot?.name || '') ? 'zh-CN' : 'en-US';
  const english = {
    '正在打开…':'Opening…', '正在保存…':'Saving…', '已保存':'Saved',
    '正在更新页面…':'Updating the page…', 'Codex 正在更新页面…':'Updating the page…',
    '保存失败':'Could not save', '继续查看':'Check progress', '应用工作区':'App workspace',
    '调整这个应用':'Update this app', '描述想怎样调整这个应用':'Describe a change',
    '生成中…':'Generating…', '生成':'Generate',
    '应用已关闭，请重新打开确认':'The app was closed. Reopen it to check the saved state.',
    '应用尚未打开':'The app has not opened yet.', '未收到保存确认':'The save was not confirmed.',
    '任务仍待确认，继续查看即可，无需重新提交。':'The request is still pending. Check its progress without submitting it again.',
    '连接暂时中断，可继续查看原任务。':'Connection interrupted. Check the existing request.',
    '本次修改未完成，原页面已保留':'This change did not complete. The previous page is preserved.',
    '没有查到原任务，未自动重新提交。':'The original request was not found. It was not submitted again.',
    '提交状态仍待确认，可继续查看，原请求不会重复提交。':'Submission is not confirmed. Check the original request.',
    '原任务尚待确认，请稍后继续查看。':'The original request is still pending. Check again shortly.',
    '未收到任务编号，请先重新打开确认状态':'No request identifier was received. Reopen the app to check its status.',
    '请求状态未确认，继续查看原任务即可。':'Request status is not confirmed. Check the original request.'
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const api = async (path, method = 'GET', body) => {
    const route = '/agent/workspaces/' + path;
    let response;
    try { response = await fetch(window.__liveuiPath ? window.__liveuiPath(route) : route, {method, headers: body === undefined ? {} : {'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(method === 'GET' ? 20000 : 60000)}); }
    catch (error) { throw Object.assign(error, {transport:true}); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(Error(data.error || '请求失败（' + response.status + '）'), {status:response.status});
    if(method!=='GET'||path.startsWith('jobs/')&&!['queued','running'].includes(data.status))window.__liveuiActivityRefresh?.();
    return data;
  };
  window.__liveuiWorkspaceSnapshots = window.__liveuiWorkspaceSnapshots || Object.create(null);
  window.LiveUIAgentRichWorkspace = function ({app}) {
    const R = window.__liveuiagentReact, h = R.createElement;
    const id = app.appId, base = encodeURIComponent(id), pendingKey = 'liveui.workspace.job.' + id;
    const [data,setData] = R.useState(null), [status,setStatus] = R.useState(workspaceLocale(app) === 'zh-CN' ? '正在打开…' : english['正在打开…']);
    const [loadError,setLoadError] = R.useState(false);
    const [draft,setDraft] = R.useState(''), [busy,setBusy] = R.useState(false), [unconfirmed,setUnconfirmed] = R.useState(false);
    const container = R.useRef(null), root = R.useRef(null), current = R.useRef(null), alive = R.useRef(true), writes = R.useRef(Promise.resolve()), task = R.useRef(null), draftRef = R.useRef('');
    const publish = snapshot => { current.current = snapshot; window.__liveuiWorkspaceSnapshots[id] = clone(snapshot); if(root.current) root.current.dataset.version = String(snapshot.version); };
    const locale = () => workspaceLocale(current.current || app);
    const t = text => locale() === 'zh-CN' ? text : (english[text] || String(text).replace(/^请求失败（(\d+)）$/, 'Request failed ($1)'));
    const show = text => { if(alive.current) setStatus(t(text)); };
    const getPending = () => { try { return sessionStorage.getItem(pendingKey); } catch { return null; } };
    const setPending = value => { try { value ? sessionStorage.setItem(pendingKey,value) : sessionStorage.removeItem(pendingKey); } catch {} };
    const load = async () => { setLoadError(false); try {const snapshot = await api(base); if(!alive.current)return; publish(snapshot); setData(snapshot); show(''); return snapshot;} catch(error){if(alive.current)setLoadError(true);throw error;} };
    const saveState = update => {
      const write = writes.current.catch(() => {}).then(async () => {
        if(!alive.current) throw Error('应用已关闭，请重新打开确认');
        const snapshot = current.current; if(!snapshot) throw Error('应用尚未打开');
        const next = update(clone(snapshot.interactionState || {})); show('正在保存…');
        const result = await api(base + '/state', 'PUT', {expectedVersion:snapshot.version,interactionState:next});
        const saved = result.snapshot || result;
        if(!Number.isInteger(saved.version)) throw Error('未收到保存确认');
        publish(saved); show('已保存'); return true;
      });
      writes.current = write; return write;
    };
    const poll = async jobId => {
      const deadline = Date.now() + 900000; let failures = 0;
      for (;;) {
        if(!alive.current) return false;
        if(Date.now() >= deadline) throw Object.assign(Error('任务仍待确认，继续查看即可，无需重新提交。'),{unconfirmed:true});
        let job;
        try { job = await api('jobs/' + encodeURIComponent(jobId)); failures = 0; }
        catch(error) { if(!error.transport && ![502,503,504].includes(error.status)) throw error; if(++failures >= 6) throw Object.assign(Error('连接暂时中断，可继续查看原任务。'),{unconfirmed:true}); await delay(1500); continue; }
        if(job.status === 'done') return true;
        if(!['running','queued'].includes(job.status)) throw Error(job.error || '本次修改未完成，原页面已保留');
        show(locale() === 'zh-CN' ? (job.stage || '正在更新页面…') : '正在更新页面…'); await delay(700);
      }
    };
    const finish = async jobId => {
      task.current = jobId; setPending(jobId); if(alive.current) {setBusy(true);setUnconfirmed(false);}
      try {
        if(jobId.startsWith('request:')) {
          let resolved;
          try {resolved=await api('requests/'+encodeURIComponent(jobId.slice(8)));}
          catch(error) {if([401,403,404].includes(error.status))throw Error(error.status===404?'没有查到原任务，未自动重新提交。':error.message);throw Object.assign(Error('提交状态仍待确认，可继续查看，原请求不会重复提交。'),{unconfirmed:true});}
          if(!resolved.id)throw Object.assign(Error('原任务尚待确认，请稍后继续查看。'),{unconfirmed:true});
          jobId=resolved.id;task.current=jobId;setPending(jobId);
        }
        if(!await poll(jobId)) return;
        await load(); setPending(null); task.current = null; show('已保存');
        window.__liveuiagentRefresh?.();
      } catch(error) {
        show(error.message);
        if(error.unconfirmed) {if(alive.current)setUnconfirmed(true);}
        else {task.current=null;setPending(null);}
      } finally { if(alive.current)setBusy(Boolean(task.current)); }
    };
    R.useEffect(() => {
      alive.current = true;
      load().then(() => {const jobId=getPending();if(jobId)void finish(jobId);}).catch(error=>show(error.message));
      return () => {alive.current=false;};
    }, [id]);
    R.useEffect(() => {if(container.current)container.current.inert=busy;}, [busy]);
    R.useEffect(() => {
      const registry=window.__ulemiBindingReloaders || (window.__ulemiBindingReloaders=new Map());
      const reload=async ()=>{let failedSave=false;await writes.current.catch(()=>{failedSave=true;});const snapshot=await api(base);if(alive.current){publish(snapshot);if(failedSave){setData(snapshot);show(locale()==='zh-CN'?'上次保存未完成，已恢复已保存内容。':'The previous save failed. Saved content was restored.');}}};
      registry.set(id,reload);
      window.__ulemiReloadAppBinding=async appId=>registry.get(appId)?.();
      return ()=>{if(registry.get(id)===reload)registry.delete(id);};
    }, [id]);
    R.useEffect(() => {
      if(!data || !container.current) return;
      const onError = event => show(event.detail?.message || '保存失败');
      const el = container.current; el.addEventListener('liveui:error',onError);
      try {
        const state = current.current.interactionState || {};
        const records = (current.current.records || []).map(record => Object.hasOwn(state.checked || {},record.id) ? {...record,checked:state.checked[record.id]} : record);
        const runtime = window.__liveuiStructuredRuntime({});
        runtime.render(el,data.tree,{locale:workspaceLocale(data),records,photos:[],richState:state.richState || {},
          onRichStateChange:(key,view)=>saveState(next=>({...next,richState:{...(next.richState||{}),[key]:view}})),
          onToggle:(recordId,checked)=>saveState(next=>({...next,checked:{...(next.checked||{}),[recordId]:checked}}))});
        el.dataset.renderedVersion=String(data.version); el.scrollTop=0;
      } catch(error) {show(error.message);}
      return () => {el.removeEventListener('liveui:error',onError);};
    }, [data]);
    const submit = async event => {
      event.preventDefault(); const prompt = draftRef.current.trim(); if(!prompt || task.current)return;
      const clientRequestId=crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''); task.current='request:'+clientRequestId;setPending(task.current);setBusy(true);setUnconfirmed(false);show('正在更新页面…');
      try {
        await writes.current;
        const rect = container.current.getBoundingClientRect();
        const job = await api(base+'/generate','POST',{prompt,clientRequestId,expectedVersion:current.current.version,viewport:{width:innerWidth,height:innerHeight,contentWidth:Math.round(rect.width)}});
        if(!job.id) throw Object.assign(Error('未收到任务编号，请先重新打开确认状态'),{transport:true});
        if(draftRef.current===prompt){draftRef.current='';setDraft('');}
        await finish(job.id);
      } catch(error) {if(error.transport){if(alive.current)setUnconfirmed(true);show('请求状态未确认，继续查看原任务即可。');}else{task.current=null;setPending(null);if(alive.current)setBusy(false);show(error.message);}}
    };
    return h('div',{ref:root,className:'complete-app-host rich-workspace-host','data-workspace-id':id,'data-version':data?.version ?? '', 'data-loading':String(!data&&!loadError),'data-empty':String(!data)},
      h('div',{className:'rich-workspace-status'},h('span',{role:'status','aria-live':'polite'},status),
        !data&&loadError ? h('button',{type:'button',onClick:()=>load().catch(error=>show(error.message))},locale()==='zh-CN'?'重新打开':'Retry') : unconfirmed ? h('button',{type:'button',onClick:()=>finish(task.current)},t('继续查看')) : null),
      h('div',{ref:container,className:'rich-workspace-content','aria-label':app.name || t('应用工作区')}),
      h('form',{className:'rich-workspace-request',onSubmit:submit},
        h('textarea',{'aria-label':t('调整这个应用'),placeholder:t('描述想怎样调整这个应用'),rows:1,maxLength:12000,value:draft,onChange:event=>{draftRef.current=event.target.value;setDraft(event.target.value);}}),
        h('button',{type:'submit',disabled:busy || !draft.trim()},t(busy?'生成中…':'生成'))));
  };
})();
