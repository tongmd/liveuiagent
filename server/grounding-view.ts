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
  'Primary-list projection is separate from complete business evidence. viewContext is fallible UI design metadata, never new user intent, a required business field, or authorization to call an extra service. Do not add deliverables or writes to satisfy it; explicit current intent and actual API requirements take precedence.',
  'When supplied, itemLabel describes the tracked primary row unit, collectionLabel is only its display label, and perItemActions describe its row affordances. It is not the internal workflow-history collection. Return actual primary units compatible with those affordances, not every object encountered or created. Containers, account summaries and discovery context remain in complete API evidence and, when relevant, verified summary/stats; do not turn them into actionable item rows.',
  'Keep every requested business deliverable, successful write, quantity and post-write read-back verifiable in apiCalls, even when the object is not a primary row. A clean list cannot hide an unfinished container or item write. Legitimate supporting-object writes are not forbidden merely because their objects are not rows.',
  'Fetch the full relevant current primary list, retaining untouched and settled units where the app tracks them; a narrow mutation does not authorize changing siblings or dropping them from the view. Never invent missing people/items. An explicitly returned entities:[] means verified no primary units, not a missing result. Omitted entities is not a verified empty list.',
].join('\n');
