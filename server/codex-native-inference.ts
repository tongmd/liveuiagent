import type { LlmRuntimeConfig } from './liveuiagent.js';

/** Authenticated inference-only relay. Credentials and transport configuration
 * are host-owned; application JSON cannot select a URL, token, or Codex model. */
export function createCodexNativeInference(env: NodeJS.ProcessEnv = process.env) {
  const base = String(env.LIVEUIAGENT_CODEX_BASE_URL || '').trim();
  const token = String(env.LIVEUIAGENT_CODEX_TOKEN || '').trim();
  if (!base || !token) return undefined;
  const url = new URL(base.replace(/\/+$/, '') + '/chat/completions');
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Codex relay requires HTTPS or a loopback HTTP endpoint without URL credentials');
  }
  const model = String(env.LIVEUIAGENT_CODEX_MODEL || 'gpt-6-astra').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model)) throw new Error('Invalid server Codex model');
  const limit = Number(env.LIVEUIAGENT_CODEX_TIMEOUT_MS || 180000);
  if (!Number.isFinite(limit) || limit < 1 || limit > 300000) throw new Error('Invalid Codex relay timeout');
  const allowedUsers = new Set(String(env.LIVEUIAGENT_CODEX_ALLOWED_USERS || '').split(',').map(value=>value.trim()).filter(Boolean));
  const concurrency = Number(env.LIVEUIAGENT_CODEX_MAX_CONCURRENT || 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid Codex inference concurrency');
  const failure = (message:string, code:string, status:number) => Object.assign(new Error(message), {code,status});
  const chatCompletion: NonNullable<LlmRuntimeConfig['chatCompletion']> = async (request, options) => {
    const requestedBudget = options?.timeoutMs ?? limit;
    if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) throw failure('Codex inference deadline exceeded', 'codex_timeout', 504);
    const budget = Math.max(1, Math.floor(Math.min(requestedBudget, limit)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(url, {
        method:'POST', signal:controller.signal, redirect:'error',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'x-liveui-timeout-ms':String(budget)},
        // All execution remains with the host. Codex only returns the requested
        // text/JSON; stale browser model settings never select another provider.
        body:JSON.stringify({...request, model, stream:false, tools:[], tool_choice:'none'}),
      });
      if (!response.ok) {
        // Inspect only a bounded envelope and return a closed known code. Relay
        // messages, unknown codes and arbitrary bodies never reach jobs or UI.
        const known = new Set(['auth_required','auth_refresh_failed','codex_http_401','codex_http_429','codex_transport_failed','timeout','busy','invalid_json']);
        let safeCode: string | undefined;
        const reader=response.body?.getReader();
        if(reader) {
          const chunks:Uint8Array[]=[];let bytes=0;
          try {
            for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096){await reader.cancel();break;}chunks.push(part.value);}
            if(bytes<=4096){const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));const code=envelope?.error?.code;if(typeof code==='string'&&known.has(code))safeCode=code;}
          } catch { /* Preserve the generic HTTP failure for unreadable bodies. */ }
          finally { reader.releaseLock(); }
        }
        const code=safeCode?(safeCode.startsWith('codex_')?safeCode:'codex_'+safeCode):'codex_upstream_error';
        throw failure(`Codex inference failed (HTTP ${response.status}${safeCode?'; '+safeCode:''})`, code, response.status === 429 ? 429 : 502);
      }
      let result: any;
      try { result = await response.json(); }
      catch { throw failure('Codex returned an unreadable response', 'codex_response_invalid', 502); }
      const message = result?.choices?.[0]?.message;
      if (!message || typeof message.content !== 'string' || !message.content.trim()
        || (Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call) {
        throw failure('Codex did not return a text completion', 'codex_response_invalid', 502);
      }
      if (result.model && result.model !== model) throw failure('Codex returned a different model', 'codex_model_mismatch', 502);
      return { ...result, model };
    } catch (error) {
      if (controller.signal.aborted) throw failure('Codex inference deadline exceeded', 'codex_timeout', 504);
      if (error && typeof error === 'object' && String((error as any).code || '').startsWith('codex_')) throw error;
      throw failure('Codex inference connection failed', 'codex_connection_failed', 502);
    } finally { clearTimeout(timer); }
  };
  return {
    model, maxConcurrent:concurrency, chatCompletion,
    allowsUser(owner:string) { return Boolean(owner) && (!allowedUsers.size || allowedUsers.has(owner)); },
    config(personalContext?:string):LlmRuntimeConfig {
      return {model,chatCompletion,nativeInferenceConcurrency:concurrency,...(personalContext?{personalContext}:{})};
    },
    view() { return {id:model,source:'codex-login',configurable:false,providerConfigurable:false,delivery:'native'}; },
  };
}
