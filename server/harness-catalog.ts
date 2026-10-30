import type { HarnessId } from './runtime-settings.js';

export const domesticHarnesses = [
  {id:'qwen',label:'Qwen Code',family:/qwen/i},
  {id:'kimi',label:'Kimi Code',family:/kimi|moonshot/i},
  {id:'zcode',label:'ZCode',family:/glm/i},
] as const;
export type DomesticHarnessId = typeof domesticHarnesses[number]['id'];
export const harnessIds = ['native','dsh','codex',...domesticHarnesses.map(h=>h.id)] as const;
export function isDomesticHarness(id:string):id is DomesticHarnessId {
  return domesticHarnesses.some(h=>h.id===id);
}
export function harnessModels(id:HarnessId,models:readonly string[]) {
  const family=id==='dsh'?/deepseek/i:domesticHarnesses.find(h=>h.id===id)?.family;
  return family?models.filter(model=>family.test(model)):[...models];
}
export function selectHarnessModel(id:HarnessId,models:readonly string[],preferred?:string) {
  const available=harnessModels(id,models);
  return preferred&&available.includes(preferred)?preferred:available[0];
}
export function harnessLabel(id:string) {
  return domesticHarnesses.find(h=>h.id===id)?.label ?? ({native:'LiveUIAgent',dsh:'DSH',codex:'Codex'} as Record<string,string>)[id] ?? id;
}
