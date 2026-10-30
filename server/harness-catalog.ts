/** Host-owned integration facts shared by routing, settings and workspaces. */
export const harnessCatalog = [
  {id:'native',label:'LiveUIAgent',family:undefined,htmlDelivery:false,richWorkspace:true},
  {id:'codex',label:'Codex',family:undefined,htmlDelivery:false,richWorkspace:true},
  {id:'dsh',label:'DeepSeek Harness',family:/deepseek/i,htmlDelivery:true,richWorkspace:true},
  {id:'qwen',label:'Qwen Code',family:/qwen/i,htmlDelivery:false,richWorkspace:true},
  {id:'kimi',label:'Kimi Code',family:/kimi|moonshot/i,htmlDelivery:false,richWorkspace:true},
  {id:'zcode',label:'ZCode',family:/glm/i,htmlDelivery:false,richWorkspace:true},
] as const;
export type HarnessId = typeof harnessCatalog[number]['id'];
export type DomesticHarnessId = Extract<HarnessId,'qwen'|'kimi'|'zcode'>;
export const domesticHarnesses = harnessCatalog.filter((item):item is Extract<typeof harnessCatalog[number],{id:DomesticHarnessId}> => ['qwen','kimi','zcode'].includes(item.id));
export const harnessIds: readonly HarnessId[] = harnessCatalog.map(item=>item.id);
export function harnessDefinition(id:string) { return harnessCatalog.find(item=>item.id===id); }
export function isDomesticHarness(id:string):id is DomesticHarnessId {
  return domesticHarnesses.some(h=>h.id===id);
}
export function harnessModels(id:HarnessId,models:readonly string[]) {
  const family=harnessDefinition(id)?.family;
  return family?models.filter(model=>family.test(model)):[...models];
}
export function selectHarnessModel(id:HarnessId,models:readonly string[],preferred?:string) {
  const available=harnessModels(id,models);
  return preferred&&available.includes(preferred)?preferred:available[0];
}
export function harnessLabel(id:string) { return harnessDefinition(id)?.label ?? id; }
