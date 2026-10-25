import { AsyncLocalStorage } from 'node:async_hooks';

// Server-owned execution context; never populated from application JSON.
const budgets = new AsyncLocalStorage<number | undefined>();
export function actionDeadlineAt() { return budgets.getStore(); }
export function actionDeadlineError() {
  return Object.assign(new Error('Action deadline exceeded. Outcome is not verified; an in-flight request may already have changed the service. Do not automatically retry writes.'), {code:'action_deadline_exceeded', status:504});
}
export function remainingActionMs(limit = Number.MAX_SAFE_INTEGER) {
  const deadline = budgets.getStore();
  if (deadline === undefined) return limit;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw actionDeadlineError();
  return Math.min(limit, remaining);
}
export function withActionDeadline<T>(deadline: number, work: () => T): T {
  if (!Number.isFinite(deadline)) throw new Error('Invalid host action deadline');
  const inherited = budgets.getStore();
  return budgets.run(inherited === undefined ? deadline : Math.min(deadline, inherited), work);
}
// Audit snapshots are read-only observations of business state, not new actions.
export function withoutActionDeadline<T>(work: () => T): T { return budgets.run(undefined, work); }
export async function actionRetryDelay(ms: number) {
  const remaining = remainingActionMs();
  const consumesBudget = actionDeadlineAt() !== undefined && ms >= remaining;
  await new Promise(resolve => setTimeout(resolve, Math.min(ms, remaining)));
  // Node timers may wake just before the requested millisecond boundary. A
  // backoff that cannot fit was not completed: never start another attempt
  // merely because that early wake left a positive fraction of the budget.
  if (consumesBudget) throw actionDeadlineError();
  remainingActionMs();
}
