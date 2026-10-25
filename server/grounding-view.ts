import {nativeViewBudget} from './native-view-budget.js';
import {parsePrimaryMembership,type PrimaryMembership} from './native-primary-projection.js';
// Existing design metadata describes a projection, not business authorization.
export type GroundingViewContext = {
  itemLabel: string;
  primaryMembership?:PrimaryMembership;
  collectionLabel?: string;
  viewResourceBudget?: ReturnType<typeof nativeViewBudget>;
  perItemActions: Array<{ id: string; label: string }>;
};
export function groundingViewContext(pkg: any, options?: {compiledNativeBudget: true}): GroundingViewContext | undefined {
  const intent = pkg?.manifest?.intent;
  const itemLabel = typeof intent?.itemLabel === 'string' ? intent.itemLabel.trim() : '';
  const primaryMembership=intent?.primaryMembership===undefined?undefined:parsePrimaryMembership(intent.primaryMembership);
  if (!itemLabel && primaryMembership===undefined) return undefined;
  const collectionLabel = typeof intent?.presentation?.collection === 'string' ? intent.presentation.collection.trim() : '';
  const surface=pkg?.ui?.meta?.a2ui;
  // Host opt-in only: legacy/emitted graphs are not this compiled-view budget contract.
  const viewResourceBudget=options?.compiledNativeBudget===true&&surface?nativeViewBudget(surface,pkg.ui.meta.hostCommand):undefined;
  return {itemLabel,...(viewResourceBudget?{viewResourceBudget}:{}),...(primaryMembership ? {primaryMembership} : {}),...(collectionLabel ? {collectionLabel} : {}),perItemActions:Object.entries(pkg?.actions?.actions ?? {})
    .filter(([, action]: [string, any]) => action?.perItem === true)
    .map(([id, action]: [string, any]) => ({id,label:String(action.label || id)}))};
}
export const groundingViewPolicy = [
  'Logical-unit identity is not necessarily backend storage-record identity. A documented API may pack multiple independently user-editable units or members into one record with shared scalar fields. Derive goals and targetCount from the explicitly requested user-facing units and outcome, not an assumed one-record representation; do not invent a requirement to keep one backend record or its count unchanged unless the user or real service semantics requires that identity.',
  'Representation-only partition is permitted only when the actual authorized API schema cannot express the requested subset change within the packed record: use only already authorized capabilities and evidenced existing membership/values to partition that representation. Preserve real user/business identities, every untargeted member and value, and the complete intended outcome; partitions must cover the original units exactly once, without omissions or overlaps. A new backend ID must come from an actual successful API response. Explicit record-identity requirements still apply. This is not permission to add/remove real business members or objects, send additional messages, create additional transactions/payments/obligations, or weaken permissions, required values, ownership or unknown-outcome locks.',
  'A proposed partition is not proof of safety or completion. Before writing, verify the original membership and values; the Write Verifier must check that the entire proposed change is only the authorized representation adjustment. Independently verify all successful writes and fresh external read-backs of the complete resulting partition against the original units, the requested subset values and every unchanged sibling value. Local metadata and a model assertion alone never prove external success. Reject missing, duplicated, invented or changed untargeted units, missing writes/read-backs, or an unresolved outcome. Do not reject a fully evidenced representation-only partition solely because it uses more than one backend record or obtains a new backend ID.',
  'projectionDisplayMode=complete-grounded is only a host full-display resource policy. It does not prove current world state, membership, business completion, permissions or a benchmark score.',
  'priorProjection, when supplied, is the complete last verified UI projection, potentially stale. It is not fresh world truth, new intent or write authorization. Use its full entities/stats to identify tracked units and verify current coverage from real reads; never silently replace it with only the current mutation result.',
  'Primary-list projection is separate from complete business evidence. viewContext is fallible UI design metadata, never new user intent, a required business field, or authorization to call an extra service. Do not add deliverables or writes to satisfy it; explicit current intent and actual API requirements take precedence.',
  'When supplied, itemLabel describes the tracked primary row unit, collectionLabel is only its display label, and perItemActions describe its row affordances. It is not the internal workflow-history collection. Return actual primary units compatible with those affordances, not every object encountered or created. Containers, account summaries and discovery context remain in complete API evidence and, when relevant, verified summary/stats; do not turn them into actionable item rows.',
  'entities[].id must be a real stable identifier of that primary unit. Preserve known stable unit IDs across updates; never change or omit them to satisfy coverage. A note/list/container ID shared by multiple units, or changing when a unit moves containers, is source provenance rather than unit identity: do not put it in entities[].id. If no real stable unit ID exists, omit id and return the verified exact unit name and group; never fabricate an ID from its name. Keep container identifiers in complete API evidence and, when useful, verified detail. Names/groups and container references do not authorize writes or authenticate record identity.',
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
