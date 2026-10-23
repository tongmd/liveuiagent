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
