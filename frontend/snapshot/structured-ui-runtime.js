// Self-contained: bootstrap embeds this function's toString into the sandbox iframe.
window.__liveuiStructuredRuntime = function structuredUiRuntime(sdk) {
  'use strict';
  const generations = new WeakMap(), active = new WeakSet();
  function validateRich(raw) {
 const bad=m=>{throw Error('Invalid rich component: '+m);};
 const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
 const exact=(x,keys)=>{if(!obj(x)||Object.keys(x).some(k=>!keys.includes(k)))bad('unknown property');};
 const num=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
 const text=x=>typeof x==='string'&&x.length<=160;
 const color=x=>typeof x==='string'&&/^#[0-9a-f]{6}$/i.test(x);
 const vec=(x,a,b)=>Array.isArray(x)&&x.length===3&&x.every(v=>num(v,a,b));
 if(raw.type==='Scene3D'){
  exact(raw.scene,['objects','background','grid','title']);const s=raw.scene;
  if(!Array.isArray(s.objects)||!s.objects.length||s.objects.length>48||s.background!==undefined&&!color(s.background)||s.grid!==undefined&&typeof s.grid!=='boolean'||s.title!==undefined&&!text(s.title))bad('scene');
  const ids=new Set();for(const o of s.objects){exact(o,['id','shape','position','scale','color','label','rotation']);if(!text(o.id)||!o.id||ids.has(o.id)||!['box','sphere','cylinder','cone','torus'].includes(o.shape)||!vec(o.position,-20,20)||!vec(o.scale,.05,10)||!color(o.color)||o.label!==undefined&&!text(o.label)||o.rotation!==undefined&&!vec(o.rotation,-360,360))bad('object');ids.add(o.id);}
 }else if(raw.type==='Plot'){
  exact(raw.plot,['series','kind','title','xLabel','yLabel']);const p=raw.plot;
  if(!['line','scatter','bar'].includes(p.kind)||!Array.isArray(p.series)||!p.series.length||p.series.length>6||['title','xLabel','yLabel'].some(k=>p[k]!==undefined&&!text(p[k])))bad('plot');
  for(const s of p.series){exact(s,['name','color','points']);if(!text(s.name)||!color(s.color)||!Array.isArray(s.points)||s.points.length<1||s.points.length>160||s.points.some(v=>!Array.isArray(v)||v.length!==2||!v.every(n=>num(n,-1e9,1e9))))bad('series');}
 }else if(raw.type==='Diagram'){
  exact(raw.diagram,['nodes','edges','title']);const d=raw.diagram;
  if(!Array.isArray(d.nodes)||!d.nodes.length||d.nodes.length>24||!Array.isArray(d.edges)||d.edges.length>48||d.title!==undefined&&!text(d.title))bad('diagram');
  const ids=new Set();for(const n of d.nodes){exact(n,['id','label','x','y','color']);if(!text(n.id)||!n.id||ids.has(n.id)||!text(n.label)||!num(n.x,0,1)||!num(n.y,0,1)||!color(n.color))bad('diagram node');ids.add(n.id);}
  for(const e of d.edges){exact(e,['from','to','label']);if(!ids.has(e.from)||!ids.has(e.to)||e.label!==undefined&&!text(e.label))bad('edge');}
 }else bad('type');
 return JSON.parse(JSON.stringify(raw.type==='Scene3D'?raw.scene:raw.type==='Plot'?raw.plot:raw.diagram));
}

  const types = new Set(['Stack', 'Grid', 'Card', 'Text', 'Image', 'List', 'Checklist', 'Scene3D', 'Plot', 'Diagram']);
  const containers = new Set(['Stack', 'Grid', 'Card', 'List', 'Checklist']);
  const fail = message => { throw Error('Invalid structured UI: ' + message); };
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  function json(value, limit = 200000) {
    let text; try { text = JSON.stringify(value); } catch { fail('data must be JSON'); }
    if (!text || new TextEncoder().encode(text).length > limit) fail('data exceeds size limit');
    return text;
  }
  function references(values, label) {
    if (!Array.isArray(values) || values.length > 80) fail(label + ' must contain at most 80 records');
    const result = new Map();
    for (const value of values) {
      if (!plain(value) || typeof value.id !== 'string' || !/^[\w.-]{1,128}$/.test(value.id) || result.has(value.id)) fail(label + ' needs unique ids');
      result.set(value.id, value);
    }
    return result;
  }
  function renderRich(raw,doc,options) {
    const host=doc.createElement('section');host.style.cssText='position:relative;min-width:0;overflow:hidden;border:1px solid #dce4ee;border-radius:18px;background:#f8fafc;color:#172033;';
    const data=raw.scene||raw.plot||raw.diagram;
    const zh=/^zh/i.test(options.locale||doc.documentElement.lang||'')||(!options.locale&&/[\u3400-\u9fff]/.test(data.title||''));
    if(data.title){const title=doc.createElement('h3');title.textContent=data.title;title.style.cssText='margin:16px;font:600 18px system-ui';host.append(title);}
    const label=(text)=>{const el=doc.createElement('span');el.textContent=text;return el;};
    const svgEl=(tag,attrs={})=>{const el=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(attrs))el.setAttribute(k,String(v));return el;};
    if(raw.type!=='Scene3D'){
      const svg=svgEl('svg',{viewBox:'0 0 640 360',role:'img','aria-label':data.title||raw.type});svg.style.cssText='display:block;width:100%;height:auto;min-height:180px';host.append(svg);
      const tx=(x,y,text,size=13)=>{const t=svgEl('text',{x,y,fill:'#536176','font-size':size,'font-family':'system-ui'});t.textContent=text;svg.append(t);return t;};
      if(raw.type==='Plot'){
        const pts=data.series.flatMap(s=>s.points),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);let minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(0,...ys),maxY=Math.max(0,...ys);if(maxX===minX)maxX++;if(maxY===minY)maxY++;
        const X=x=>58+(x-minX)/(maxX-minX)*548,Y=y=>304-(y-minY)/(maxY-minY)*260;
        for(let i=0;i<=4;i++){const y=44+i*65;svg.append(svgEl('line',{x1:58,y1:y,x2:606,y2:y,stroke:'#e0e7ef'}));tx(5,y+4,Number(maxY-(maxY-minY)*i/4).toPrecision(3));}
        svg.append(svgEl('line',{x1:58,y1:304,x2:606,y2:304,stroke:'#8090a3'}));tx(58,328,String(minX));tx(568,328,String(maxX));tx(270,352,data.xLabel||'');tx(10,22,data.yLabel||'');
        data.series.forEach((s,j)=>{if(data.kind==='line')svg.append(svgEl('polyline',{points:s.points.map(p=>X(p[0])+','+Y(p[1])).join(' '),fill:'none',stroke:s.color,'stroke-width':3}));
          s.points.forEach(p=>{const mark=data.kind==='bar'?svgEl('rect',{x:X(p[0])-Math.max(2,200/pts.length),y:Math.min(Y(p[1]),Y(0)),width:Math.max(4,380/pts.length),height:Math.max(1,Math.abs(Y(p[1])-Y(0))),fill:s.color}):svgEl('circle',{cx:X(p[0]),cy:Y(p[1]),r:4,fill:s.color});const title=svgEl('title');title.textContent=s.name+': '+p[0]+', '+p[1];mark.append(title);svg.append(mark);});tx(65+j*170,22,s.name).setAttribute('fill',s.color);});
      }else{
        const nodes=new Map(data.nodes.map(n=>[n.id,n]));for(const e of data.edges){const a=nodes.get(e.from),b=nodes.get(e.to);svg.append(svgEl('line',{x1:50+a.x*540,y1:40+a.y*280,x2:50+b.x*540,y2:40+b.y*280,stroke:'#a0adbd','stroke-width':2}));if(e.label)tx(50+(a.x+b.x)*270,35+(a.y+b.y)*140,e.label);}
        for(const n of data.nodes){const g=svgEl('g',{tabindex:0,role:'button','aria-label':n.label});g.style.cursor='pointer';g.append(svgEl('circle',{cx:50+n.x*540,cy:40+n.y*280,r:22,fill:n.color}));const t=svgEl('text',{x:50+n.x*540,y:76+n.y*280,'text-anchor':'middle','font-size':14,'font-family':'system-ui',fill:'#172033'});t.textContent=n.label;g.append(t);g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();g.dispatchEvent(new MouseEvent('click'));}});g.addEventListener('click',()=>{for(const el of svg.querySelectorAll('circle'))el.setAttribute('stroke','none');g.firstChild.setAttribute('stroke','#172033');g.firstChild.setAttribute('stroke-width','4');});svg.append(g);}
      }
      let resize=null,unmount=null,disposed=false;
      const fitLabels=()=>{const w=svg.getBoundingClientRect().width||480;for(const text of svg.querySelectorAll('text')){const base=Number(text.dataset.baseFont||text.getAttribute('font-size')||13);text.dataset.baseFont=String(base);text.setAttribute('font-size',String(Math.min(28,base*Math.max(1,640/w))));}};
      svg.__liveuiMount=()=>{if(disposed)return;fitLabels();if(typeof ResizeObserver==='function'&&!resize){resize=new ResizeObserver(fitLabels);resize.observe(svg);}if(typeof MutationObserver==='function'&&!unmount){unmount=new MutationObserver(()=>{if(!host.isConnected)svg.__liveuiDispose();});unmount.observe(doc.documentElement,{childList:true,subtree:true});}};
      svg.__liveuiDispose=()=>{disposed=true;resize?.disconnect();unmount?.disconnect();};return host;
    }
    const canvas=doc.createElement('canvas');canvas.setAttribute('aria-label',data.title||(zh?'可交互三维场景':'Interactive 3D scene'));canvas.setAttribute('role','img');canvas.tabIndex=0;canvas.style.cssText='width:100%;height:330px;display:block;touch-action:none;cursor:grab';host.append(canvas);
    const controls=doc.createElement('div');controls.style.cssText='display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:12px 16px;background:#fff;font:14px system-ui';
    const spread=doc.createElement('input');spread.type='range';spread.min='.3';spread.max='2.5';spread.step='.05';spread.value='1';spread.setAttribute('aria-label',zh?'调整物体间距':'Spread objects');spread.style.cssText='min-width:100px;flex:1';
    const reset=doc.createElement('button');reset.type='button';reset.textContent=zh?'重置视角':'Reset view';reset.style.cssText='border:1px solid #d5dce6;border-radius:8px;background:white;padding:8px 12px;color:#172033';controls.append(label(zh?'间距':'Spread'),spread,reset);host.append(controls);
    const legend=doc.createElement('div');legend.style.cssText='display:flex;flex-wrap:wrap;gap:10px;padding:0 16px 12px;font:13px system-ui';for(const o of data.objects){const l=label(o.label||o.id);l.style.color=o.color;legend.append(l);}host.append(legend);
    const gl=canvas.getContext('webgl',{antialias:true,preserveDrawingBuffer:true});if(!gl){const msg=label(zh?'此设备暂不支持三维渲染。':'3D rendering is unavailable on this device.');host.append(msg);return host;}
    host.dataset.renderer='webgl';
    const shader=(kind,src)=>{const s=gl.createShader(kind);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))fail('3D shader');return s;};
    const program=gl.createProgram();const vertex=shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec3 c;varying vec3 col;void main(){gl_Position=vec4(p,1.0);col=c;}');const fragment=shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 col;void main(){gl_FragColor=vec4(col,1.0);}');gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);if(!gl.getProgramParameter(program,gl.LINK_STATUS))fail('3D program');gl.useProgram(program);
    const pLoc=gl.getAttribLocation(program,'p'),cLoc=gl.getAttribLocation(program,'c'),pb=gl.createBuffer(),cb=gl.createBuffer();
    const key=JSON.stringify(data.objects.map(o=>o.id));let view={yaw:.55,pitch:-.35,zoom:1,spread:1,...(options.richState?.[key]||{})};
    for(const k of ['yaw','pitch','zoom','spread'])if(!Number.isFinite(view[k]))view[k]={yaw:.55,pitch:-.35,zoom:1,spread:1}[k];view.zoom=Math.max(.4,Math.min(2.5,view.zoom));view.spread=Math.max(.3,Math.min(2.5,view.spread));spread.value=String(view.spread);
    const emit=()=>{host.dataset.view=JSON.stringify(view);if(typeof options.onRichStateChange==='function')Promise.resolve(options.onRichStateChange(key,{...view})).catch(e=>host.dispatchEvent(new CustomEvent('liveui:error',{bubbles:true,detail:{message:String(e.message||e)}})));};
    function mesh(shape){const verts=[];const tri=(a,b,c)=>verts.push([a,b,c]);
      if(shape==='box'){const v=[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];for(const q of [[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[3,0,4,7]]){tri(v[q[0]],v[q[1]],v[q[2]]);tri(v[q[0]],v[q[2]],v[q[3]]);}}
      else{const torus=shape==='torus',sphere=shape==='sphere',N=20,M=sphere?12:torus?10:1;const at=(i,j)=>{const u=i/N*Math.PI*2,v=j/M*Math.PI*2;if(torus)return[(.65+.22*Math.cos(v))*Math.cos(u),.22*Math.sin(v),(.65+.22*Math.cos(v))*Math.sin(u)];if(sphere){const a=j/M*Math.PI;return[.6*Math.sin(a)*Math.cos(u),.6*Math.cos(a),.6*Math.sin(a)*Math.sin(u)];}const r=shape==='cone'?(1-j)*.6:.5;return[r*Math.cos(u),j-.5,r*Math.sin(u)];};for(let i=0;i<N;i++)for(let j=0;j<M;j++){const a=at(i,j),b=at(i+1,j),c=at(i+1,j+1),d=at(i,j+1);tri(a,b,c);tri(a,c,d);}if(!sphere&&!torus)for(let i=0;i<N;i++){tri([0,-.5,0],at(i+1,0),at(i,0));tri([0,.5,0],at(i,1),at(i+1,1));}}
      return verts;
    }
    const meshes=data.objects.map(o=>mesh(o.shape));
    const rot=(v,a,axis)=>{const c=Math.cos(a),s=Math.sin(a),[x,y,z]=v;return axis===0?[x,y*c-z*s,y*s+z*c]:axis===1?[x*c+z*s,y,-x*s+z*c]:[x*c-y*s,x*s+y*c,z];};
    function draw(){const width=Math.max(240,canvas.clientWidth||480),height=330,dpr=Math.min(2,doc.defaultView.devicePixelRatio||1);canvas.width=width*dpr;canvas.height=height*dpr;gl.viewport(0,0,canvas.width,canvas.height);const color=data.background||'#eef3fa';gl.clearColor(parseInt(color.slice(1,3),16)/255,parseInt(color.slice(3,5),16)/255,parseInt(color.slice(5,7),16)/255,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
      const positions=[],colors=[];const extent=Math.max(2,...data.objects.map(o=>Math.hypot(...o.position)*view.spread+Math.max(...o.scale)));const camera=extent*(1+2.6/Math.min(1,width/height))/view.zoom;
      for(let k=0;k<data.objects.length;k++){const o=data.objects[k],rgb=[1,3,5].map(i=>parseInt(o.color.slice(i,i+2),16)/255);for(const face of meshes[k]){const transformed=face.map(v=>{let a=v.map((n,i)=>n*o.scale[i]);for(let i=0;i<3;i++)a=rot(a,(o.rotation?.[i]||0)*Math.PI/180,i);a=a.map((n,i)=>n+o.position[i]*view.spread);a=rot(rot(a,view.yaw,1),view.pitch,0);return a;});const a=transformed[0],b=transformed[1],c=transformed[2],u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n)||1,shade=.4+.6*Math.abs((n[0]*.3+n[1]*.8+n[2]*.5)/len);for(const q of transformed){const dist=Math.max(.2,camera-q[2]);positions.push(q[0]/dist*2.3/(width/height),q[1]/dist*2.3,Math.max(-.99,Math.min(.99,-q[2]/(extent*5))));colors.push(...rgb.map(n=>Math.min(1,n*shade)));}}}
      for(const[loc,buffer,values]of[[pLoc,pb,positions],[cLoc,cb,colors]]){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}gl.drawArrays(gl.TRIANGLES,0,positions.length/3);host.dataset.triangles=String(positions.length/9);
      if(data.grid!==false){const lines=[],gridColors=[];for(let i=-5;i<=5;i++)for(const axis of [0,1])for(const side of [-1,1]){let q=axis===0?[i/5*extent*.8,-extent*.4,side*extent*.8]:[side*extent*.8,-extent*.4,i/5*extent*.8];q=rot(rot(q,view.yaw,1),view.pitch,0);const dist=Math.max(.2,camera-q[2]);lines.push(q[0]/dist*2.3/(width/height),q[1]/dist*2.3,Math.max(-.99,Math.min(.99,-q[2]/(extent*5))));gridColors.push(.76,.80,.86);}for(const[loc,buffer,values]of[[pLoc,pb,lines],[cLoc,cb,gridColors]]){gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,0,0);}gl.drawArrays(gl.LINES,0,lines.length/3);}
      host.dataset.view=JSON.stringify(view);
    }
    let pointer=null;canvas.addEventListener('pointerdown',e=>{pointer=[e.clientX,e.clientY];canvas.setPointerCapture?.(e.pointerId);});canvas.addEventListener('pointermove',e=>{if(!pointer)return;view.yaw+=(e.clientX-pointer[0])*.009;view.pitch=Math.max(-1.4,Math.min(1.4,view.pitch+(e.clientY-pointer[1])*.009));pointer=[e.clientX,e.clientY];draw();});canvas.addEventListener('pointerup',()=>{pointer=null;emit();});canvas.addEventListener('pointercancel',()=>{pointer=null;emit();});canvas.addEventListener('wheel',e=>{e.preventDefault();view.zoom=Math.max(.4,Math.min(2.5,view.zoom*Math.exp(-e.deltaY*.001)));draw();emit();},{passive:false});canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')view.yaw-=.15;if(e.key==='ArrowRight')view.yaw+=.15;if(e.key==='ArrowUp')view.pitch-=.15;if(e.key==='ArrowDown')view.pitch+=.15;if(e.key==='+')view.zoom=Math.min(2.5,view.zoom+.1);if(e.key==='-')view.zoom=Math.max(.4,view.zoom-.1);draw();emit();});spread.addEventListener('input',()=>{view.spread=Number(spread.value);draw();});spread.addEventListener('change',emit);reset.addEventListener('click',()=>{view={yaw:.55,pitch:-.35,zoom:1,spread:1};spread.value='1';draw();emit();});
    // Detached build renders once at a conservative size; connection/resize refines resolution without a perpetual animation loop.
    draw();let ro=null,mo=null,disposed=false;
    canvas.__liveuiMount=()=>{if(disposed)return;draw();if(!ro&&typeof ResizeObserver==='function'){ro=new ResizeObserver(()=>{if(host.isConnected&&!disposed)draw();});ro.observe(canvas);}if(!mo&&typeof MutationObserver==='function'){mo=new MutationObserver(()=>{if(!host.isConnected)canvas.__liveuiDispose();});mo.observe(doc.documentElement,{childList:true,subtree:true});}};
    canvas.__liveuiDispose=()=>{if(disposed)return;disposed=true;ro?.disconnect();mo?.disconnect();gl.deleteBuffer(pb);gl.deleteBuffer(cb);gl.deleteProgram(program);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.dataset.disposed='true';};

    return host;
  }

  function build(tree, options = {}) {
    json(tree, 64000);
    const records = references(options.records || [], 'records'), photos = references(options.photos || [], 'photos');
    const seenRecords = new Set(), seenPhotos = new Set();
    let count = 0, textLength = 0, sceneCount = 0;
    const richRoots=[];
    const doc = options.document || document;
    function recordContent(record, checklist) {
      const wrapper = doc.createElement(checklist ? 'label' : 'div');
      wrapper.style.cssText = 'display:flex;align-items:flex-start;gap:10px;min-width:0;max-width:100%;';
      if (checklist) {
        const input = doc.createElement('input'); input.type = 'checkbox';
        input.checked = typeof record.checked === 'boolean' ? record.checked : record.completed === true;
        let committedChecked = input.checked;
        input.disabled = typeof options.onToggle !== 'function';
        input.style.cssText = 'width:18px;height:18px;flex:0 0 auto;margin:3px 0;';
        input.addEventListener('change', async () => {
          const previous = committedChecked;
          const checked = input.checked; input.disabled = true;
          try { const result = await options.onToggle(record.id, checked); if (result === false) throw Error('Could not save this change'); committedChecked = checked; }
          catch (error) { input.checked = previous; wrapper.dispatchEvent(new CustomEvent('liveui:error', {bubbles:true,detail:{message:String(error.message || error)}})); }
          finally { input.disabled = false; }
        });
        wrapper.append(input);
      }
      const content = doc.createElement('div'); content.style.cssText = 'min-width:0;overflow-wrap:anywhere;white-space:pre-wrap;';
      // Original record fields remain authoritative; no model text substitutes for them.
      const excluded = new Set(['id', 'checked', 'completed']);
      for (const [key, value] of Object.entries(record)) {
        if (excluded.has(key) || value === undefined || value === null || value === '') continue;
        const line = doc.createElement('div');
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        line.textContent = ['text','title','name','label','body','content','description','detail'].includes(key) ? text : key + ': ' + text;
        content.append(line);
      }
      if (!content.childNodes.length) content.textContent = record.id;
      wrapper.append(content); return wrapper;
    }
    function visit(raw, depth, checklist = false) {
      if (++count > 200 || depth > 10 || !plain(raw) || !types.has(raw.type)) fail('unsupported node or tree limit');
      if(raw.type==='Scene3D'&&++sceneCount>4)fail('at most 4 Scene3D views per tree');
      const allowed = new Set(['type','style','recordId']);
      if (containers.has(raw.type)) allowed.add('children');
      if(raw.type==='Scene3D')allowed.add('scene');if(raw.type==='Plot')allowed.add('plot');if(raw.type==='Diagram')allowed.add('diagram');
      if (raw.type === 'Text') { allowed.add('text'); allowed.add('checked'); }
      if (raw.type === 'Checklist') allowed.add('checked');
      if (raw.type === 'Image') { allowed.add('photoId'); allowed.add('text'); }
      for (const key of Object.keys(raw)) if (!allowed.has(key)) fail('unsupported property ' + key);
      const node = doc.createElement('div'); node.dataset.liveuiComponent = raw.type;
      node.style.cssText = 'box-sizing:border-box;min-width:0;max-width:100%;font-size:16px;line-height:1.5;overflow-wrap:anywhere;';
      if (raw.text !== undefined) {
        if (typeof raw.text !== 'string' || raw.text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw.text) || (textLength += raw.text.length) > 16000) fail('invalid text');
      }
      if (raw.checked !== undefined && typeof raw.checked !== 'boolean') fail('invalid checked');
      if (raw.recordId !== undefined) {
        if (typeof raw.recordId !== 'string' || !records.has(raw.recordId)) fail('unknown record reference');
        seenRecords.add(raw.recordId); node.dataset.recordId = raw.recordId;
        node.append(recordContent(records.get(raw.recordId), checklist || raw.type === 'Checklist' || raw.checked !== undefined));
      }
      if (raw.type === 'Text') {
        if (!raw.text && !raw.recordId) fail('Text requires content');
        // Do not replace original record text with generated copy.
        if (raw.text && !raw.recordId) { const text = doc.createElement('span'); text.textContent = raw.text; text.style.whiteSpace = 'pre-wrap'; node.append(text); }
      }
      if (raw.type === 'Image') {
        if (typeof raw.photoId !== 'string' || !photos.has(raw.photoId)) fail('unknown photo reference');
        const photo = photos.get(raw.photoId), src = photo.src || photo.url;
        // SVG is excluded even as a data URI. Never accept a model-supplied source.
        if (typeof src !== 'string' || (!/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(src) && !/^blob:[^\s<>]+$/.test(src))) fail('photo must be a local raster or blob');
        const image = doc.createElement('img'); image.src = src; image.alt = raw.text || 'Photo';
        image.style.cssText = 'display:block;width:100%;max-width:100%;max-height:440px;object-fit:contain;height:auto;border-radius:10px;'; node.append(image);seenPhotos.add(raw.photoId);
      }
      if (['Scene3D','Plot','Diagram'].includes(raw.type)) { validateRich(raw); const rich=renderRich(raw,doc,options);richRoots.push(rich);node.append(rich); }
      let style = {};
      if (raw.style !== undefined) {
        if (!plain(raw.style)) fail('invalid style'); style = raw.style;
        const enums = {direction:['row','column'],tone:['default','muted','accent'],align:['start','center','end']};
        for (const [key,value] of Object.entries(style)) {
          if (Object.hasOwn(enums,key)) { if (typeof value !== 'string' || !enums[key].includes(value)) fail('invalid style ' + key); }
          else if (['gap','padding','columns'].includes(key)) { if (!Number.isInteger(value) || value < (key === 'columns' ? 1 : 0) || value > (key === 'columns' ? 4 : 32)) fail('invalid style ' + key); }
          else fail('unsupported style ' + key);
        }
      }
      const gap = style.gap ?? 12;
      if (containers.has(raw.type)) {
        if (!Array.isArray(raw.children) || raw.children.length > 80 || (!raw.children.length && !raw.recordId)) fail('container requires bounded children');
        node.style.display = 'flex'; node.style.flexDirection = style.direction || 'column'; node.style.gap = gap + 'px';
        if (style.direction === 'row') node.style.flexWrap = 'wrap';
        if (raw.type === 'Grid') {
          const columns = style.columns || 2;node.style.display = 'grid';node.style.alignItems = 'start';
          node.style.gridTemplateColumns = `repeat(auto-fit,minmax(min(100%,max(180px,calc((100% - ${gap * (columns - 1)}px) / ${columns}))),1fr))`;
        }
        if (raw.type === 'Card') { node.style.padding = '16px';node.style.border = '1px solid #dce2e8';node.style.borderRadius = '12px';node.style.backgroundColor = '#ffffff'; }
        for (const child of raw.children) node.append(visit(child,depth+1,checklist || raw.type === 'Checklist'));
      }
      if (style.padding !== undefined) node.style.padding = style.padding + 'px';
      if (style.align) node.style.textAlign = style.align;
      if (style.tone === 'muted') node.style.color = '#536176';
      if (style.tone === 'accent') node.style.color = '#2456a6';
      return node;
    }
    let root;try {root = visit(tree,1);
    if ([...records.keys()].some(id=>!seenRecords.has(id)) || [...photos.keys()].some(id=>!seenPhotos.has(id))) fail('omitted source content');
    return root;}catch(error){for(const rich of richRoots)disposeRich(rich);throw error;}
  }
  function mountRich(root){for(const canvas of root.querySelectorAll('canvas,svg'))canvas.__liveuiMount?.();}
  function disposeRich(root){for(const canvas of root.querySelectorAll('canvas,svg'))canvas.__liveuiDispose?.();}
  function render(container, tree, options = {}) {
    if (!container || typeof container.replaceChildren !== 'function') fail('invalid container');
    const root = build(tree,{...options,document:container.ownerDocument});
    generations.set(container,(generations.get(container)||0)+1);disposeRich(container);container.replaceChildren(root);mountRich(root);return root;
  }
  async function generate(container,prompt,options) {
    if (!container?.isConnected || !options || typeof options.getRecords !== 'function' || typeof options.storageKey !== 'string' || !options.storageKey) fail('invalid generation options');
    if (active.has(container)) throw Error('Wait for the current layout to finish');
    active.add(container);
    let candidate=null;
    const version = (generations.get(container)||0)+1;generations.set(container,version);
    const requestId = 'ui-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
    const snapshot = () => json(options.getRecords());
    try {
      const originalChildren = Array.from(container.childNodes);
      const childrenUnchanged = () => container.childNodes.length === originalChildren.length && originalChildren.every((child,index)=>container.childNodes[index] === child);
      const fingerprint = snapshot(),records = JSON.parse(fingerprint),photos = (options.getPhotos ? options.getPhotos() : []).map(photo=>({...photo}));
      references(records,'records');references(photos,'photos');
      const photosUnchanged = () => { const latest = options.getPhotos ? options.getPhotos() : []; return latest.length === photos.length && latest.every((photo,index)=>photo.id === photos[index].id && (photo.src || photo.url) === (photos[index].src || photos[index].url)); };
      const current = () => container.isConnected && childrenUnchanged() && generations.get(container) === version && snapshot() === fingerprint && photosUnchanged();
      const previousTree = options.tree ?? options.previousTree;
      if (previousTree !== undefined) json(previousTree,64000); // Prior references may legitimately differ after source edits.
      const response = await sdk.ai(prompt,{uiProtocol:'liveui-tree-v1',requestId,records,photos:photos.map(photo=>({id:photo.id})),...(previousTree !== undefined ? {tree:previousTree} : {})});
      if (response?.requestId !== requestId) fail('mismatched generation response');
      const tree = response?.data?.tree;
      candidate = build(tree,{records,photos,onToggle:options.onToggle,richState:options.richState,onRichStateChange:options.onRichStateChange,document:container.ownerDocument});
      if (!current()) throw Error('Content changed while generating. Generate again.');
      const state = {tree,requestId,updatedAt:new Date().toISOString(),recordsFingerprint:fingerprint};
      await sdk.save(options.storageKey,json(state,100000));
      if (!current()) throw Error('Content changed while saving. Reopen or generate again.');
      disposeRich(container);container.replaceChildren(candidate);mountRich(candidate);candidate=null;return state;
    } finally { if(candidate)disposeRich(candidate);active.delete(container); }
  }
  function read(storageKey) {
    const raw = sdk.storage.getItem(storageKey);if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || raw.length > 100000) fail('saved state exceeds limit');
    let state;try { state = JSON.parse(raw); } catch { fail('saved state is not JSON'); }
    if (!plain(state) || !plain(state.tree) || typeof state.requestId !== 'string' || typeof state.updatedAt !== 'string') fail('invalid saved state');
    json(state.tree,64000);return state;
  }
  return {render,generate,read};
};
