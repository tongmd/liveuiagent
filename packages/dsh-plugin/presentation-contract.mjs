// Host interpretation of explicit user requirements only. Never inspect generated HTML.
const components = ['Scene3D', 'Plot', 'Diagram'];
const names = {
  Scene3D: /Scene3D|\b3d\b(?!\s*print)|三维(?!打印)|three[- ]dimensional/ig,
  Plot: /\bPlot\b|\bcharts?\b|图表|折线图|散点图|柱状图|条形图|走势图|曲线/ig,
  Diagram: /\bDiagram\b|\bflowcharts?\b|node[- ]link|流程图|关系图|架构图|节点图|连线图|示意图/ig,
};
const surface = /界面|组件|布局|页面|\bui\b|interface|layout|screen/i;
const dynamic = /动态|实时|每次|重新|根据|按我|按用户|随.*(?:需求|交互)|dynamic|regenerat|rebuild|evolv|on each|every (?:interaction|request)/i;
const change = /生成|组织|重建|改变|更新|变化|演进|重排|generate|rebuild|reorganiz|evolv|regenerat|updat|adapt/i;
const richAction = /生成|添加|加入|加上|保留|展示|显示|渲染|画|改成|改为|换成|切换|改用|需要|使用|要|用|\b(?:render|add|keep|show|include|use|replace|switch|generate)\b/i;
const explanation = /^\s*(?:解释|介绍|什么是|explain\b|what (?:is|are)\b|describe (?:what|how)\b)/i;
const disableDynamic = /(?:不要|不需要|无需|禁止|取消|移除|不使用|不用|别再)[^，,。！？;；\n]{0,12}(?:动态|实时)[^，,。！？;；\n]{0,12}(?:生成|界面|组件|布局|页面|ui\b|3d|三维)|(?:不要|不需要|不再|停止|取消|别再)[^，,。！？;；\n]{0,8}(?:生成|重建|重排)[^，,。！？;；\n]{0,8}(?:界面|组件|布局|页面|ui\b)|(?:do not|don't|disable|without|no|stop)\s+(?:(?:dynamically|dynamic|live)\s+(?:generat\w*|regenerat\w*|ui|interface|layout)|(?:generat\w*|regenerat\w*|rebuild\w*)\b[^,.;\n]{0,24}(?:ui|interface|layout)|(?:ui|interface|layout)\s+(?:generation|regeneration|updates?))/i;

function negated(clause, index, length) {
  const before = clause.slice(0, index), after = clause.slice(index + length);
  // "Don't remove 3D" keeps the existing requirement rather than disabling it.
  if (/(?:不要|不用|无需)\s*(?:移除|删除|去掉)[^，,。！？;；\n]{0,8}$|(?:do not|don't)\s+(?:remove|disable)\s*$/i.test(before)) return false;
  return /(?:不要|不需要|不想要|无需|禁止|取消|移除|去掉|不使用|不用)[^，,。！？;；\n]{0,18}$|(?:no|without|remove|disable|do not|don't)\s+(?:\w+\s+){0,4}$/i.test(before)
    || /^\s*(?:不需要|不要了|去掉|取消)/i.test(after);
}

export function presentationContractForRequest(request, history = []) {
  let enabled = false, generic = false, required = new Set();
  const strings = [
    ...(Array.isArray(history) ? history.slice(-6).map(v => typeof v === 'string' ? v : typeof v?.prompt === 'string' ? v.prompt : '') : []),
    typeof request === 'string' ? request : '',
  ];
  for (const text of strings) {
    let positive = [], mentioned = new Set(), explicit = false;
    for (const clause of text.split(/[，,。！？;；\n]|\bbut\b|但是|而是/gi)) {
      if (explanation.test(clause)) continue;
      // Local sliders/keystrokes changing plotted values are not requests to
      // generate a new UI structure or to invoke a model on every input event.
      if (/滑块|拖动|鼠标移动|每次按键|每次键入|\b(?:slider|keypress|keystroke)\b|on input/i.test(clause)
        && !/生成|组织|重建|重排|重组|布局|结构|generat|rebuild|reorganiz|layout|structure/i.test(clause)) continue;
      if (disableDynamic.test(clause)) {
        enabled = false; generic = false; required.clear();
        positive = []; mentioned.clear(); explicit = true;
        continue;
      }
      let remaining = clause;
      const localPositive = new Set();
      for (const type of components) {
        for (const match of clause.matchAll(new RegExp(names[type]))) {
          if (negated(clause, match.index, match[0].length)) {
            required.delete(type); mentioned.delete(type);
            remaining = remaining.replace(match[0], '');
          } else {
            localPositive.add(type);
            mentioned.add(type);
            if (enabled && (change.test(clause) || richAction.test(clause))) required.add(type);
          }
        }
      }
      if (enabled && /只(?:要|需要|使用|保留)|仅(?:要|需|使用|保留)|\bonly\b|\binstead\b|改为|换成|切换到|\breplace\b/i.test(clause)
        && (localPositive.size || surface.test(clause) && dynamic.test(clause) && change.test(clause))) {
        required = new Set(localPositive); mentioned = new Set(localPositive);
        generic = surface.test(clause); positive = [];
      }
      positive.push(remaining);
      const joined = positive.join(' ');
      if (dynamic.test(joined) && change.test(joined) && (surface.test(joined) || mentioned.size)) {
        // A new explicit generation request defines the current presentation;
        // unrelated edits inherit it, while removals cannot revive old types.
        if (!explicit) { required = new Set(mentioned); generic = surface.test(joined); }
        else { for (const type of mentioned) required.add(type); generic ||= surface.test(joined); }
        enabled = true; explicit = true;
      }
    }
    if (!required.size && !generic) enabled = false;
  }
  return enabled ? { protocol: 'liveui-tree-v1', components: components.filter(type => required.has(type)) } : undefined;
}

export function validatePresentationContract(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['protocol', 'components'].includes(k))
    || value.protocol !== 'liveui-tree-v1' || !Array.isArray(value.components)
    || value.components.length > components.length
    || Array.from(value.components).some(type => !components.includes(type))
    || new Set(value.components).size !== value.components.length) throw Error('Invalid host presentation contract');
  return { protocol: 'liveui-tree-v1', components: components.filter(type => value.components.includes(type)) };
}
