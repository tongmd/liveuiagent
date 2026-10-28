# Deploy LiveUIAgent

Deploy to an authenticated **`/liveui/`** route on an existing Linux host:

```sh
npm run deploy -- --host YOUR_SSH_HOST \
  --remote-env /etc/liveuiagent.env \
  --nginx-site /etc/nginx/sites-available/YOUR_SITE \
  --auth-file /etc/nginx/YOUR_HTPASSWD
```

Requires Git, Bash, SSH/SCP locally; noninteractive `sudo`, an unprivileged application account, Python 3.12+, systemd, Nginx, and Node.js 22 remotely. Add `--bootstrap` on Debian/Ubuntu to install Node and browser dependencies. The Nginx site must already exist. Use `--server-name` to select a server block when its file contains several.

## Configuration

Keep a private environment file on the server:

```dotenv
OPENAI_API_BASE=https://YOUR_PROVIDER/v1
OPENAI_API_KEY=YOUR_PRIVATE_KEY
LIVEUIAGENT_ORCHESTRATOR_MODEL=YOUR_MODEL_ID
LIVEUI_DEFAULT_HARNESS=native
```

Repeat `--remote-env` to merge files in order, with later values taking precedence. Alternatively, use `--env-file /private/liveui.env` to upload a local file. Secrets stay outside Git and are stored in private deployment snapshots.

| Variable | Purpose |
| --- | --- |
| `LIVEUIAGENT_MODEL_CHOICES` | Comma-separated model choices for the shared provider |
| `DB_PATH` | Absolute SQLite path for apps, settings, and Memory |
| `GENERATED_APPS_DIR` | Absolute app registry path |
| `LIVEUI_EVALUATION_DIR` | Absolute evaluator output path |
| `CHROME_PATH` | Existing Chrome/Chromium executable; otherwise downloaded automatically |
| `LIVEUIAGENT_DSH_API_BASE` | Optional trusted DSH service API root, including its mount prefix |
| `LIVEUI_DSH_USER_PREFIX` | Optional account namespace when sharing a DSH service |
| `LIVEUI_DSH_EMPTY_ACCOUNT_ROOT` | Optional same-host DSH data root for empty account initialization; requires a namespace |
| `APPWORLD_ENABLED` | Enable a separately installed AppWorld integration |
| `APPWORLD_API_BASE` | AppWorld endpoint, such as `http://127.0.0.1:9000` |

Users can override provider settings in Settings. Saved keys reside in SQLite; protect the database and its backups. The DSH service must support model/provider overrides for those controls to work. AppWorld and DSH are managed separately from this deployment.

## Authentication

Use an existing htpasswd file, or replace `--auth-file` with:

```sh
--auth-user YOUR_LOGIN --password-file /private/liveui-password
```

The password file contains one nonempty line. The proxy authenticates requests and overwrites `X-LiveUIAgent-User`; the backend binds to loopback on port `8791`. Keep that identity-trusting backend private. Generated apps and evaluators can perform actions through configured services.

## Storage and releases

```text
/srv/liveuiagent/
  releases/<commit>/
  current -> releases/<commit>/
  shared/data/liveui.db
  shared/generated-apps/
  shared/evaluations/
  shared/browsers/
  shared/configs/
  transactions/
  rollback.json
```

Existing storage paths in the environment override these defaults. Use `--root`, `--service`, `--port`, or `--user` for another installation. Back up SQLite and the app registry together. Old releases and user data are retained.

The script deploys a clean committed checkout, installs locked dependencies, builds the runtime, checks Chrome, and tests Nginx before activation. `--staged` deploys the Git index and rejects unstaged tracked edits. A failed readiness check restores the previous release and proxy settings. Activation briefly restarts the service; finish active generation/evaluation jobs first.

Rollback restores code and configuration while preserving database writes:

```sh
npm run deploy -- --host YOUR_SSH_HOST --rollback
```

Use the same `--root` for a nondefault installation. Database migrations must remain compatible with the previous release.

```sh
sudo systemctl status liveuiagent
sudo journalctl -u liveuiagent --since '10 minutes ago'
curl --fail http://127.0.0.1:8791/health
sudo nginx -t
```

Run `npm run deploy -- --help` for all options. Verify the public app, model selection, and evaluator downloads after deployment.

## Codex through an existing ChatGPT login

The optional Codex harness uses a relay on the machine where Codex is already logged in. The relay uses the local Codex Responses transport for JSON inference and the installed `codex app-server` only to refresh that login. It supplies no model tools, skills, private conversation history, or filesystem context. LiveUIAgent continues to own planning, tool execution, and application data.

Requirements: Python 3.11+, an installed Codex CLI with a working ChatGPT login, and a private connection between the relay and the LiveUIAgent server. API-key login is not supported by this relay. The internal Codex Responses endpoint can change; request failures are reported without switching providers or silently retrying inference.

Create a private bearer token file outside the repository, then run:

```sh
python3 deploy/codex-relay/relay.py \
  --token-file /private/liveui-codex-token \
  --model gpt-6-astra --effort high --port 19503
```

`--codex` selects a CLI executable when it is not on `PATH`; `--auth-file` defaults to `~/.codex/auth.json`. `LIVEUI_CODEX_PROXY` can supply an HTTPS proxy URL if required. The relay binds only to `127.0.0.1`; both `/health` and `/v1/chat/completions` require its bearer token.

For a remote LiveUIAgent host, forward its loopback port back to the logged-in machine. Run the relay and tunnel under your process supervisor:

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:19503:127.0.0.1:19503 YOUR_SSH_HOST
```

Set these in the private LiveUIAgent server environment:

```dotenv
LIVEUIAGENT_CODEX_BASE_URL=http://127.0.0.1:19503/v1
LIVEUIAGENT_CODEX_TOKEN=YOUR_RELAY_BEARER_TOKEN
LIVEUIAGENT_CODEX_ALLOWED_USERS=YOUR_LIVEUI_ACCOUNT
LIVEUIAGENT_CODEX_MODEL=gpt-6-astra
LIVEUIAGENT_CODEX_TIMEOUT_MS=180000
LIVEUIAGENT_CODEX_MAX_CONCURRENT=2
```

Keep the OAuth login on its original machine; only the separate relay bearer belongs on the server. Leave the allowlist empty to disable access. The relay machine must stay online and connected, and its Codex account must have available capacity. Existing Native and DSH choices remain available.

The relay accepts ordered textual messages and optional JSON schemas, requires valid JSON output, and rejects model tool output. Each inference has its own subprocess, cleaned up when the request finishes, times out, or disconnects. It admits at most four requests concurrently, limits request bodies to 2 MiB, and defaults to a 180-second deadline including authentication refresh. Client deadlines can shorten that limit. It does not log prompts, response bodies, or credentials.

Run the transport checks without making model calls:

```sh
python3 -m unittest discover -s deploy/codex-relay -v
```
