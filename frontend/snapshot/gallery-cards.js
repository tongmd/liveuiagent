/* Render real saved visuals; never execute an app or generate content for a thumbnail. */
(() => {
  'use strict';
  const cache=new Map(),queue=[];let active=0;
  const pump=()=>{while(active<3&&queue.length){active++;const {run,resolve,reject}=queue.shift();Promise.resolve().then(run).then(resolve,reject).finally(()=>{active--;pump();});}};
  const queued=run=>new Promise((resolve,reject)=>{queue.push({run,resolve,reject});pump();});
  const parse=v=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return null;}};
  function visualOf(tree){if(!tree||typeof tree!=='object')return null;if(['Scene3D','Plot','Diagram'].includes(tree.type))return tree;for(const child of tree.children||[]){const found=visualOf(child);if(found)return found;}return null;}
  function savedPreview(data){
    const values=Object.values(data.store||{}).map(parse).filter(x=>x&&typeof x==='object');
    const layouts=values.filter(x=>x.tree).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const tree=data.tree||layouts[0]?.tree;
    const photos=values.flatMap(x=>Array.isArray(x.photos)?x.photos:[]).map(x=>x.dataUrl||x.data||x.src).filter(x=>typeof x==='string'&&/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(x)).slice(0,3);
    return {visual:visualOf(tree),tree,photos,richState:data.interactionState?.richState||values.find(x=>x.richState)?.richState||{}};
  }
  function load(app){
    const key=app.appId+':'+app.version+':'+app.updatedAt;
    for(const cached of cache.keys())if(cached.startsWith(app.appId+':')&&cached!==key)cache.delete(cached);
    if(!cache.has(key))cache.set(key,queued(async()=>{const path='/agent/'+(app.richWorkspace?'workspaces/':'complete/apps/')+encodeURIComponent(app.appId);const response=await fetch(window.__liveuiPath?window.__liveuiPath(path):path,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Preview unavailable');return savedPreview(await response.json());}).catch(()=>null));
    return cache.get(key);
  }
  const caption=app=>String(app.description||app.preview?.presentation?.tagline||'').replace(/\s+/g,' ').trim();
  window.LiveUIAgentGalleryCard=function({app,onOpen,selected,busy}){
    const R=window.__liveuiagentReact,h=R.createElement,root=R.useRef(null),cover=R.useRef(null);
    const [saved,setSaved]=R.useState(null),[ready,setReady]=R.useState(false);
    const accent=/^#[\da-f]{6}$/i.test(app.preview?.accent||'')?app.preview.accent:'#526b61';
    const items=(app.preview?.widget?.items||app.preview?.sampleRecords||[]).filter(x=>x.name||x.title).slice(0,3);
    const glyph=String(app.preview?.presentation?.glyph||Array.from(app.name||'A')[0]);
    R.useEffect(()=>{
      let alive=true;setSaved(null);setReady(false);if(!app.completeApp&&!app.richWorkspace)return;
      const refresh=event=>{if(event.detail?.appId!==app.appId)return;for(const key of cache.keys())if(key.startsWith(app.appId+':'))cache.delete(key);load(app).then(value=>{if(alive)setSaved(value);});};
      const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();load(app).then(value=>{if(alive)setSaved(value);});}},{rootMargin:'180px'});
      observer.observe(root.current);window.addEventListener('liveui:gallery-refresh',refresh);
      return()=>{alive=false;observer.disconnect();window.removeEventListener('liveui:gallery-refresh',refresh);};
    },[app.appId,app.version,app.updatedAt]);
    R.useEffect(()=>{
      if(!saved?.visual||!cover.current||!window.__liveuiStructuredRuntime)return;
      const shell=cover.current,shadow=shell.shadowRoot||shell.attachShadow({mode:'open'}),style=document.createElement('style');
      style.textContent=':host{display:block;height:100%;overflow:hidden;pointer-events:none}.stage{width:560px;height:336px;transform-origin:top left;overflow:hidden}h3,button,input,label,[data-plot-legend]{display:none!important}section{border:0!important;border-radius:0!important}canvas{display:block}';
      const stage=document.createElement('div');stage.className='stage';stage.inert=true;shadow.replaceChildren(style,stage);
      const runtime=window.__liveuiStructuredRuntime({});
      try{const node=JSON.parse(JSON.stringify(saved.visual));node.style={width:560,height:336};runtime.render(stage,node,{locale:'zh-CN',records:[],photos:[],richState:saved.richState});setReady(true);}catch{setReady(false);}
      const fit=()=>{stage.style.transform='scale('+shell.clientWidth/560+')';},resize=new ResizeObserver(fit);resize.observe(shell);fit();
      return()=>{resize.disconnect();try{runtime.render(stage,{type:'Text',text:''});}catch{}shadow.replaceChildren();};
    },[saved]);
    const kind=({Scene3D:'三维空间',Plot:'图表',Diagram:'关系图'})[saved?.visual?.type]||(saved?.photos?.length?'照片':'');
    return h('button',{ref:root,type:'button',className:'morph-material liveui-gallery-card'+(selected?' is-selected':''),'data-app-id':app.appId,'data-personal-material':true,'data-search-text':app.name+' '+caption(app),'aria-label':'打开 '+app.name,onClick:onOpen,style:{'--gallery-accent':accent}},
      h('span',{className:'gallery-cover'+(ready?' has-visual':''),'aria-hidden':true},h('span',{ref:cover,className:'gallery-visual'}),
        !ready&&saved?.photos?.length?h('span',{className:'gallery-photos'},saved.photos.map((src,i)=>h('img',{src,alt:'',key:i,loading:'lazy'}))):null,
        !ready&&!saved?.photos?.length?h('span',{className:'gallery-fallback'},(!app.completeApp&&!app.richWorkspace&&items.length)?items.map((item,i)=>h('span',{key:i,className:'gallery-record'},h('i',null,String(i+1).padStart(2,'0')),h('span',null,String(item.name||item.title)))):h('span',{className:'gallery-monogram'},glyph),h('span',{className:'gallery-cover-line'})):null,
        kind?h('span',{className:'gallery-kind'},kind):null),
      h('span',{className:'gallery-copy'},h('span',{className:'gallery-title'},h('strong',null,app.name),h('span',{className:'gallery-arrow','aria-hidden':true},'↗')),h('span',{className:'gallery-description'},caption(app))),busy?h('span',{className:'gallery-busy'},'正在更新…'):null);
  };
})();
