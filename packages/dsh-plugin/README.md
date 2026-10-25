# LiveUIAgent for DeepSeek Harness

`@liveuiagent/dsh-plugin` mounts LiveUIAgent at `/liveuiagent/` inside an authenticated DSH web profile. It generates and revises HTML apps, persists app data, and provides Memory for saved preferences. The plugin exposes its browser bridge as `window.liveuiagent`.

## Setup

Supported host: **DSH 0.2.0-rc.2, Cordis 4.0.4, Node.js 22.19 or newer**. Configure the DSH provider and browser authentication first.

```sh
dsh plugin --profile web add /absolute/path/to/liveuiagent/packages/dsh-plugin
dsh --profile web --patch /absolute/path/to/liveuiagent.patch.yml
```

Copy `examples/liveuiagent.patch.yml` outside the checkout and set `dataDir` and `owner`. Open the authenticated DSH launch URL, then `/liveuiagent/` on the same host. Behind a proxy, configure DSH Connection's `trustedHosts` and preserve Host/Origin handling. The plugin uses the signed DSH browser cookie; `X-LiveUIAgent-User` does not select or authenticate an operator.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| `basePath` | `/liveuiagent` | Non-root route prefix; nested prefixes are supported |
| `dataDir` | Required | Absolute writable directory for persistent data |
| `owner` | Required | Stable operator label; all requests share this workspace |
| `frontendDir` | Packaged `public/` | Optional absolute frontend directory |
| `model` | `DSH profile` | Default model label; provider settings belong to the DSH profile or a supported request override |
| `maxPending` | `8` | Queue bound; one unfinished task per operator |
| `timeoutMs` | `900000` | Task timeout before cancellation |
| `runner.command` | `dsh` | Executable launched without a shell |
| `runner.args` | `[--profile, headless, --json]` | Arguments; `{work}` and `{home}` expand per task |
| `runner.passEnv` | `[DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL]` | Extra environment variables passed to tasks |

Each task has its own working directory and `DSH_HOME`. The shipped `headless` profile is the default; parent custom profiles and credential stores are not copied. To configure a custom profile, include `--patch /absolute/path/to/headless.patch.yml` in `runner.args` before `--json`. Add required provider/proxy variables to `runner.passEnv`; a custom list replaces its defaults.

The command runner advertises model/provider override capabilities through `GET /api/runtime-settings`. Overrides must satisfy the runner's capabilities and supply the provider configuration it requires. Unsupported overrides fail explicitly. Working-directory separation is not an OS sandbox: tasks run with the service account's permissions.

## Delivery verification

Install Chrome or Chromium on the service host. Set `CHROME_PATH` when it is outside the standard installation paths. The service uses a real browser to reject blank applications, script errors, external network dependencies and agent calls during startup. A missing browser is an explicit delivery failure.

Generation first writes metadata and a working application within four minutes, then allows one bounded repair if delivery checks fail. A passing startup check confirms the app opens; it does not establish that its business workflows succeed.

When hosted through LiveUIAgent with AppWorld enabled, connected-service actions call `window.liveuiagent.ai(prompt, context)`. The host plans and executes real service APIs, reviews the outcome, and persists its own execution evidence. Generated code must display errors and treat only `ok === true` as verified success. Standalone DSH action execution does not acquire this service integration automatically.

## API and storage

Routes are relative to `basePath`:

| Route | Purpose |
| --- | --- |
| `GET /api/health`, `GET /api/state` | Status, apps, jobs, and memory |
| `GET /api/runtime-settings` | Runner model/provider capabilities |
| `POST /api/generate` | Create an app or revise one using `appId` |
| `GET/DELETE /api/jobs/:id` | Read progress or cancel a task |
| `GET/DELETE /api/apps/:id` | Open or delete an app |
| `PUT /api/apps/:id/store` | Save app data |
| `POST /api/apps/:id/action` | Run an in-app DSH task |
| `GET /api/apps/:id/download` | Download HTML |
| `PUT /api/memory`, `DELETE /api/memory/:id` | Edit or remove saved preferences |

Writes require JSON and the same DSH authentication as reads. State lives under `dataDir/accounts/<hash-of-owner>/`, including `state.json`, app files, and task directories. Changing `owner` selects a different namespace. Back up this directory before deployment changes. Plugin disposal removes its route, cancels work, and waits for persistence.

## Development

```sh
npm ci --workspace @liveuiagent/dsh-plugin --include-workspace-root
npm run test:dsh
# Optional real-browser fixture test; set CHROME_PATH if needed.
node packages/dsh-plugin/tests/browser-smoke.mjs
```

Tests exercise the actual pinned DSH authentication and plugin lifecycle with a fixture runner. The browser check covers generation, persistence, revision, Memory, and polling failures without model API calls. It retains evidence under `.test-runs/`.
