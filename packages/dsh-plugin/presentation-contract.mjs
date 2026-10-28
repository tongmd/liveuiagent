// Host interpretation of explicit user requirements only. Never inspect generated HTML.
export function presentationContractForRequest(request, history = []) {
  const negative=/(?:不要|不需要|无需|禁止|取消|移除|去掉|不使用)[^，,。！？;；\n]{0,18}(?:3d|三维)|(?:no|without|remove|disable|do not|don't)\s+(?:\w+\s+){0,4}(?:3d|three[- ]dimensional)/i;
  const disableDynamic=/(?:不要|不需要|无需|取消|移除)[^，,。！？;；\n]{0,8}(?:动态|实时)[^，,。！？;；\n]{0,8}(?:生成|界面|ui\b)|(?:do not|don't|disable|without)\s+(?:dynamically|dynamic)\s+(?:generate|regenerate|ui)/i;
  const classify=text=>{
    let state,positive=[];
    for(const clause of text.split(/[，,。！？;；\n]/)){
      if(negative.test(clause)||disableDynamic.test(clause)){state=false;positive=[];continue;}
      positive.push(clause);const joined=positive.join(' ');
      const spatial=/(?:3d|三维|three[- ]dimensional)/i.test(joined)&&/(?:渲染|旋转|交互|空间|场景|结构|render|rotat|interact|scene|spatial)/i.test(joined);
      const dynamic=/(?:动态|实时|每次|重新|根据|按我|按用户|dynamic|regenerat|rebuild)/i.test(joined)&&/(?:生成|组织|重建|改变|更新|generate|rebuild|reorganiz)/i.test(joined)&&/(?:界面|组件|场景|结构|ui\b|interface|scene|3d|三维)/i.test(joined);
      if(spatial&&dynamic)state=true;
    }
    return state;
  };
  // Current message wins; otherwise use the latest explicit historical intent,
  // so a removed visualization is not resurrected by an older request.
  const strings=[typeof request==='string'?request:'',...(Array.isArray(history)?history.slice(-6).reverse().map(v=>typeof v==='string'?v:typeof v?.prompt==='string'?v.prompt:''):[])];
  for(const text of strings){const state=classify(text);if(state!==undefined)return state?{protocol:'liveui-tree-v1',components:['Scene3D']}:undefined;}
  return undefined;
}

export function validatePresentationContract(value){
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['protocol','components'].includes(k))||value.protocol!=='liveui-tree-v1'||!Array.isArray(value.components)||value.components.length!==1||value.components[0]!=='Scene3D')throw Error('Invalid host presentation contract');
  return{protocol:'liveui-tree-v1',components:['Scene3D']};
}
