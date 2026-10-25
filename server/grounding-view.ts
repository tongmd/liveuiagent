// Existing design metadata describes a projection, not business authorization.
export type GroundingViewContext = {
  itemLabel: string;
  collectionLabel?: string;
  perItemActions: Array<{ id: string; label: string }>;
};
export function groundingViewContext(pkg: any): GroundingViewContext | undefined {
  const intent = pkg?.manifest?.intent;
  const itemLabel = typeof intent?.itemLabel === 'string' ? intent.itemLabel.trim() : '';
  if (!itemLabel) return undefined;
  const collectionLabel = typeof intent?.presentation?.collection === 'string' ? intent.presentation.collection.trim() : '';
  return {itemLabel,...(collectionLabel ? {collectionLabel} : {}),perItemActions:Object.entries(pkg?.actions?.actions ?? {})
    .filter(([, action]: [string, any]) => action?.perItem === true)
    .map(([id, action]: [string, any]) => ({id,label:String(action.label || id)}))};
}
export const groundingViewPolicy = [
  'priorProjection, when supplied, is the complete last verified UI projection, potentially stale. It is not fresh world truth, new intent or write authorization. Use its full entities/stats to identify tracked units and verify current coverage from real reads; never silently replace it with only the current mutation result.',
  'Primary-list projection is separate from complete business evidence. viewContext is fallible UI design metadata, never new user intent, a required business field, or authorization to call an extra service. Do not add deliverables or writes to satisfy it; explicit current intent and actual API requirements take precedence.',
  'When supplied, itemLabel describes the tracked primary row unit, collectionLabel is only its display label, and perItemActions describe its row affordances. It is not the internal workflow-history collection. Return actual primary units compatible with those affordances, not every object encountered or created. Containers, account summaries and discovery context remain in complete API evidence and, when relevant, verified summary/stats; do not turn them into actionable item rows.',
  'Keep every requested business deliverable, successful write, quantity and post-write read-back verifiable in apiCalls, even when the object is not a primary row. A clean list cannot hide an unfinished container or item write. Legitimate supporting-object writes are not forbidden merely because their objects are not rows.',
  'Fetch the full relevant current primary list, retaining untouched and settled units where the app tracks them; a narrow mutation does not authorize changing siblings or dropping them from the view. Never invent missing people/items. An explicitly returned entities:[] means verified no primary units, not a missing result. Omitted entities is not a verified empty list.',
].join('\n');

export type ProjectionPolicy = 'retain_existing' | 'replace_or_filter' | 'unspecified';
export function parseProjectionPolicy(value: unknown): ProjectionPolicy {
  if (value === undefined) return 'unspecified';
  if (value === 'retain_existing' || value === 'replace_or_filter' || value === 'unspecified') return value;
  throw new Error('Model contract error: projectionPolicy must be retain_existing, replace_or_filter, or unspecified when provided');
}
// Tokens only detect a missing prior unit; name/group are not business identities.
export function projectionCoverageGaps(policy: ProjectionPolicy, prior: unknown[], current: unknown[]): string[] {
  if (policy !== 'retain_existing') return [];
  const row = (value: any) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string' && value.name.trim() ? value : null;
  const oldRows = prior.map(row).filter(Boolean);
  const newRows = current.map(row).filter(Boolean);
  const consumed = new Set<number>();
  const nameCount = (rows: any[], name: string) => rows.filter(item => item.name === name).length;
  // Match ID-bearing rows first so a fallback name cannot consume their evidence.
  const ordered = oldRows.map((value, index) => ({value, index})).sort((a, b) => Number(Boolean(b.value.id)) - Number(Boolean(a.value.id)));
  const missing: Array<{index: number; value: any}> = [];
  for (const {value: old, index} of ordered) {
    const hasId = typeof old.id === 'string' && Boolean(old.id.trim());
    const uniqueName = nameCount(oldRows, old.name) === 1 && nameCount(newRows, old.name) === 1;
    const found = newRows.findIndex((next, nextIndex) => !consumed.has(nextIndex) && (hasId
      ? next.id === old.id
      : next.name === old.name && (uniqueName || String(next.group ?? '') === String(old.group ?? ''))));
    if (found >= 0) consumed.add(found); else missing.push({index, value: old});
  }
  return missing.sort((a, b) => a.index - b.index).map(({value: old}) =>
    `projection_coverage: retain_existing omitted prior unit ${JSON.stringify({name: old.name, ...(old.id ? {id: old.id} : {}), ...(old.group ? {group: old.group} : {})})}; read-only repair must verify the full tracked list, preserve confirmed write receipts, and never repeat writes`);
}
