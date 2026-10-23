import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from '@deepseek-ai/schemastery';

export const name = 'liveuiagent';
export const inject = ['webServer', 'connection'];

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const defaultArgs = ['--profile', 'headless', '--json'];

export const Config = Schema.object({
  basePath: Schema.string().default('/liveuiagent'),
  dataDir: Schema.string().required(),
  frontendDir: Schema.string().default(publicDir),
  owner: Schema.string().required(),
  model: Schema.string().default('DSH profile'),
  maxPending: Schema.natural().min(1).default(8),
  timeoutMs: Schema.natural().min(1).default(900000),
  runner: Schema.object({
    command: Schema.string().default('dsh'),
    args: Schema.array(String).default(defaultArgs),
    passEnv: Schema.array(String).default(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']),
  }).default({}),
});

export function normalizeConfig(input = {}) {
  const config = Config(input);
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(config.basePath)) {
    throw new TypeError('LIVEUIAGENT basePath must be a non-root path without a trailing slash, query, or dot segments');
  }
  for (const key of ['dataDir', 'frontendDir']) {
    if (!path.isAbsolute(config[key])) throw new TypeError(`LIVEUIAGENT ${key} must be an absolute path`);
    config[key] = path.normalize(config[key]);
  }
  if (!config.owner.trim() || config.owner.length > 60 || /[\x00-\x1f\x7f]/.test(config.owner)) {
    throw new TypeError('LIVEUIAGENT owner must be an explicit workspace label of 1–60 characters');
  }
  config.owner = config.owner.trim();
  if (!config.runner.command.trim()) throw new TypeError('LIVEUIAGENT runner.command must not be empty');
  if (config.runner.passEnv.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new TypeError('LIVEUIAGENT runner.passEnv entries must be valid environment variable names');
  }
  return config;
}

function refuse(res, status) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: status === 401 ? 'DSH browser authentication required' : 'DSH request rejected' }));
}

/** Factories keep HTTP/authentication integration tests independent of model execution. */
export function createLiveUIAgentPlugin({
  createRuntime = async (config) => (await import('./runtime.mjs')).createLiveUIAgentRuntime(config),
  createRunner = async (config) => (await import('./runner.mjs')).createCommandRunner(config),
} = {}) {
  return {
    name,
    inject,
    Config,
    async apply(ctx, input) {
      const config = normalizeConfig(input);
      // A missing official fence is a host compatibility error, never anonymous mode.
      if (typeof ctx.connection.requestRejection !== 'function' || typeof ctx.connection.authorizeIndex !== 'function') {
        throw new TypeError('LIVEUIAGENT requires the authenticated DSH 0.2.0-rc.2 Connection interface');
      }
      const runner = await createRunner(config.runner);
      let runtime;
      let disposed;
      const close = () => disposed ??= (async () => {
        // A constructed runtime owns the runner. Before that, startup owns it.
        if (runtime) await runtime.dispose();
        else await runner.dispose?.();
      })();
      try {
        runtime = await createRuntime({ ...config, runner });
        ctx.effect(() => {
          const unregister = ctx.webServer.register({
            kind: 'prefix',
            path: config.basePath,
            async handler(req, res) {
              // This is Connection's own Host/Origin/Sec-Fetch-Site + signed-cookie check.
              const rejection = ctx.connection.requestRejection(req);
              if (rejection === 403) { refuse(res, 403); return; }
              if (!ctx.connection.authorizeIndex(req, res)) return;
              if (rejection !== undefined) { refuse(res, rejection); return; }
              // Identity is the fixed configured workspace, never a client-selected user.
              delete req.headers['x-liveuiagent-user'];
              await runtime.handle(req, res);
            },
          });
          return async () => {
            unregister();
            await close();
          };
        }, 'liveuiagent: authenticated route and runtime');
      } catch (error) {
        try { await close(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'LIVEUIAGENT startup and cleanup failed'); }
        throw error;
      }
    },
  };
}

export const apply = createLiveUIAgentPlugin().apply;
export default { name, inject, Config, apply };
