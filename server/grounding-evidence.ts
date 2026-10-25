// Grounding must reason from actual, ordered business evidence. Transport
// authentication is not business context; omit only these exact key spellings.
const authenticationKeys = new Set([
  'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'id_token', 'idToken',
  'api_key', 'apiKey', 'client_secret', 'clientSecret', 'authorization', 'Authorization',
  'password', 'verification_code', 'verificationCode', 'password_reset_code', 'passwordResetCode',
  'session_token', 'sessionToken', 'csrf_token', 'csrfToken', 'cookie', 'Cookie', 'set-cookie', 'Set-Cookie',
]);
export function projectBusinessEvidence(input: unknown, prefix = ''): { value: unknown; omittedAuthenticationKeys: string[] } {
  const omittedAuthenticationKeys: string[] = [];
  function visit(value: unknown, at: string): unknown {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${at}[${index}]`));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
        const location = at ? `${at}.${key}` : key;
        if (authenticationKeys.has(key)) { omittedAuthenticationKeys.push(location); return []; }
        return [[key, visit(item, location)]];
      }));
    }
    return value;
  }
  return { value: visit(input, prefix), omittedAuthenticationKeys };
}
// No response truncation, stale-entry stripping, SQL substitution, or proposal
// promotion. The caller's bounded execution loop supplies at most 64 attempts;
// the Native provider rejects an oversized context explicitly.
export function groundingEvidenceHistory(log: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return log.map(entry => {
    const projected = projectBusinessEvidence(entry);
    return { ...(projected.value as Record<string, unknown>), ...(projected.omittedAuthenticationKeys.length ? { omittedAuthenticationKeys: projected.omittedAuthenticationKeys } : {}) };
  });
}
export function actualGroundingEvidence(input: { api: string; order: number; request: unknown; response: unknown; requestSource?: 'bridge-returned-request' | 'web-tool-dispatched-arguments' }): Record<string, unknown> {
  return groundingEvidenceHistory([{ ...input, ok: true, executionState: 'succeeded', requestSource: input.requestSource ?? 'bridge-returned-request' }])[0];
}
export function attemptedGroundingEvidence(input: { api: string; order: number; attemptedArguments: unknown; executionState: 'not_started' | 'outcome_unknown'; error: string }): Record<string, unknown> {
  return groundingEvidenceHistory([{ ...input, ok: false, automaticRetry: false }])[0];
}
