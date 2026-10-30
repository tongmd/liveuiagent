import type Database from 'better-sqlite3';
import type express from 'express';

export type HarnessId = 'native' | 'dsh' | 'codex' | 'qwen' | 'kimi' | 'zcode';
export type HarnessChoice = { id: HarnessId; label: string; available: boolean; reason?: string; description?: string };

export function runtimeError(message: string, code: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** Harness selection is independent of provider credentials and model preferences. */
export function createRuntimeSettings(db: Database.Database, options: {
  userOf: (req: express.Request) => string;
  choicesOf: (req: express.Request) => HarnessChoice[];
  modelOf: (req: express.Request, harness: HarnessId) => Promise<Record<string, unknown>>;
  defaultHarness?: HarnessId;
  onSelect?: (req: express.Request, harness: HarnessId) => void;
  appHarnessOf?: (req: express.Request, appId: string) => HarnessId | undefined;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_runtime_settings (
    owner TEXT PRIMARY KEY, harness TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  function saved(req: express.Request) {
    return db.prepare('SELECT harness, updated_at FROM user_runtime_settings WHERE owner = ?')
      .get(options.userOf(req)) as { harness: HarnessId; updated_at: string } | undefined;
  }
  function validate(req: express.Request, value: unknown): HarnessId {
    const choice = options.choicesOf(req).find(item => item.id === value);
    if (!choice) throw runtimeError('Unknown harness. Choose one of the advertised runtime choices.', 'harness_unknown');
    if (!choice.available) throw runtimeError(choice.reason || `${choice.label} is unavailable`, 'harness_unavailable', 503);
    return choice.id;
  }
  function selected(req: express.Request): HarnessId { return saved(req)?.harness ?? options.defaultHarness ?? 'native'; }
  function forRequest(req: express.Request, appId?: string): HarnessId {
    const explicit = req.body?.harness;
    const appHarness: HarnessId | undefined = appId ? (options.appHarnessOf?.(req,appId) ?? (appId.startsWith('dsh_') ? 'dsh' : 'native')) : undefined;
    if (explicit !== undefined) {
      const harness = validate(req, explicit);
      if (appHarness && harness !== appHarness) {
        throw runtimeError('This app belongs to a different harness. Existing apps keep their original runtime; create a new app to use another harness.', 'app_harness_mismatch', 409);
      }
      return harness;
    }
    // App affinity preserves existing data after the default for new apps changes.
    if (appHarness) return validate(req, appHarness);
    const preference = saved(req);
    // Retain old clients' explicit complete-app requests until a preference is saved.
    return validate(req, preference?.harness ?? (req.body?.completeApp === true ? 'dsh' : options.defaultHarness ?? 'native'));
  }
  async function view(req: express.Request) {
    const preference = saved(req);
    const harness = selected(req);
    return {
      harness,
      choices: options.choicesOf(req),
      model: await options.modelOf(req, harness),
      updatedAt: preference?.updated_at ?? null,
      existingAppsKeepHarness: true,
    };
  }
  function install(app: express.Express) {
    app.get('/agent/runtime-settings', async (req, res, next) => {
      try { res.json(await view(req)); } catch (error) { next(error); }
    });
    app.patch('/agent/runtime-settings', async (req, res, next) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
          || Object.keys(req.body).some(key => key !== 'harness')) {
          throw runtimeError('Expected { harness }. Model and provider settings use /agent/settings.', 'runtime_settings_invalid');
        }
        const harness = validate(req, req.body.harness);
        db.transaction(()=>{
        options.onSelect?.(req,harness);
        db.prepare(`INSERT INTO user_runtime_settings(owner, harness, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(owner) DO UPDATE SET harness = excluded.harness, updated_at = excluded.updated_at`)
          .run(options.userOf(req), harness, new Date().toISOString());
        })();
        res.json(await view(req));
      } catch (error) { next(error); }
    });
  }
  return { install, forRequest, selected, view };
}
