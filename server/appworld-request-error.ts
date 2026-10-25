// Constructed only around local argument/preflight validation before the
// business request is dispatched. Remote payload fields cannot forge this type.
export class AppWorldRequestNotStartedError extends Error {
  readonly appWorldBusinessRequest = 'not_started' as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'AppWorld request rejected before dispatch', {cause});
    this.name = 'AppWorldRequestNotStartedError';
  }
}

// Status is copied from the actual HTTP Response by fetchJson, never parsed
// from response JSON or a message substring.
export class AppWorldHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'AppWorldHttpError'; }
}
