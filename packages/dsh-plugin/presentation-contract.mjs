// Host interpretation of explicit user requirements only. Never inspect generated HTML.
export function presentationContractForRequest(request, history = []) {
  const current=typeof request==='string'?request:'';
  const negative=/(?:不要|不需要|无需|禁止|取消|移除|去掉|不使用)[^。！？;；\n]{0,18}(?:3d|三维)|(?:no|without|remove|disable|do not|don't)\s+(?:\w+\s+){0,4}(?:3d|three[- ]dimensional)/i;
  const disableDynamic=/(?:不要|不需要|无需|取消|移除)[^。！？;；\n]{0,8}(?:动态|实时)[^。！？;；\n]{0,8}(?:生成|界面|ui\b)|(?:do not|don't|disable|without)\s+(?:dynamically|dynamic)\s+(?:generate|regenerate|ui)/i;
  if(negative.test(current)||disableDynamic.test(current))return undefined;
  const strings=[current,...(Array.isArray(history)?history.slice(-6).map(v=>typeof v==='string'?v:typeof v?.prompt==='string'?v.prompt:''):[])];
  for(const text of strings){
    const positive=text.split(/[。！？;；\n]/).filter(s=>!negative.test(s)).join(' ');
    const spatial=/(?:3d|三维|three[- ]dimensional)/i.test(positive)&&/(?:渲染|旋转|交互|空间|场景|结构|render|rotat|interact|scene|spatial)/i.test(positive);
    const dynamic=/(?:动态|实时|每次|重新|根据|按我|按用户|dynamic|regenerat|rebuild)/i.test(positive)&&/(?:生成|组织|重建|改变|更新|generate|rebuild|reorganiz)/i.test(positive)&&/(?:界面|组件|场景|结构|ui\b|interface|scene|3d|三维)/i.test(positive);
    if(spatial&&dynamic)return{protocol:'liveui-tree-v1',components:['Scene3D']};
  }
  return undefined;
}
export function validatePresentationContract(value){
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['protocol','components'].includes(k))||value.protocol!=='liveui-tree-v1'||!Array.isArray(value.components)||value.components.length!==1||value.components[0]!=='Scene3D')throw Error('Invalid host presentation contract');
  return{protocol:'liveui-tree-v1',components:['Scene3D']};
}
