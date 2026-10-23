#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'EOF'
Deploy a committed checkout through SSH (Linux/systemd/Nginx, Node 22).

  bash scripts/deploy-liveui.sh --host SSH_HOST \
    --remote-env /etc/liveuiagent.env \
    --nginx-site /etc/nginx/sites-available/example \
    --auth-file /etc/nginx/liveui.htpasswd

Options:
  --host HOST             SSH alias or user@host; required
  --env-file FILE         Upload a private local dotenv file (alternative to --remote-env)
  --remote-env PATH       Reuse a private env file; repeat in precedence order (last wins)
  --nginx-site PATH       Existing server configuration to update, preserving other routes
  --server-name NAME      Select one server block when the file contains several
  --auth-file PATH        Existing server-side htpasswd file
  --auth-user USER        Initial login, with --password-file (alternative to --auth-file)
  --password-file FILE    Private local file containing the initial password
  --root PATH             Installation directory (default /srv/liveuiagent)
  --user USER             Existing unprivileged application user (default SSH login)
  --port PORT             Loopback backend port (default 8791)
  --service NAME          Systemd service (default liveuiagent)
  --chrome-path PATH      Existing server Chrome; otherwise env CHROME_PATH or pinned download
  --bootstrap            Install Ubuntu/Debian dependencies and Node 22 if needed
  --timeout SECONDS       Readiness timeout (default 90)
  --staged                Deploy the audited Git index instead of HEAD (no unstaged changes)
  --rollback              Restore the previous successful release/proxy; preserve user data
  --help                  Show this help

Secrets are never included in the source archive or printed. Requires sudo -n remotely.
EOF
}
host='' env_file='' password_file='' remote_env_count=0 rollback=false archive_mode=committed
forward=()
while (($#)); do
  case "$1" in
    --host) host=${2:?}; shift 2 ;;
    --env-file) env_file=${2:?}; shift 2 ;;
    --password-file) password_file=${2:?}; shift 2 ;;
    --remote-env) remote_env_count=$((remote_env_count+1)); forward+=("$1" "${2:?}"); shift 2 ;;
    --root|--user|--port|--service|--nginx-site|--server-name|--auth-file|--auth-user|--chrome-path|--timeout)
      forward+=("$1" "${2:?}"); shift 2 ;;
    --bootstrap) forward+=("$1"); shift ;;
    --staged) archive_mode=staged; shift ;;
    --rollback) rollback=true; forward+=("$1"); shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ $host =~ ^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$ ]] || { echo 'Provide a valid --host SSH alias or user@host.' >&2; exit 2; }
[[ -z $env_file || $remote_env_count == 0 ]] || { echo 'Choose --env-file or --remote-env.' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
local_tmp=$(mktemp -d)
remote_tmp=''
cleanup() {
  rm -rf -- "$local_tmp"
  if [[ $remote_tmp == /tmp/liveui-deploy.* ]]; then ssh "$host" "rm -rf -- '$remote_tmp'" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
if [[ $rollback == false ]]; then
  for file in deploy/remote.py deploy/nginx.py deploy/runtime.mjs scripts/deploy-liveui.sh scripts/deploy-archive.sh; do
    git -C "$repo" ls-files --error-unmatch "$file" >/dev/null || { echo 'Commit deployment files before deployment.' >&2; exit 2; }
  done
  revision=$(bash "$repo/scripts/deploy-archive.sh" "$repo" "$local_tmp/source.tar.gz" "$archive_mode")
  if command -v sha256sum >/dev/null; then checksum=$(sha256sum "$local_tmp/source.tar.gz" | cut -d ' ' -f 1)
  else checksum=$(shasum -a 256 "$local_tmp/source.tar.gz" | cut -d ' ' -f 1); fi
fi
remote_tmp=$(ssh "$host" 'umask 077; mktemp -d /tmp/liveui-deploy.XXXXXXXX')
[[ $remote_tmp =~ ^/tmp/liveui-deploy\.[A-Za-z0-9]+$ ]] || { echo 'Invalid upload directory from SSH.' >&2; exit 1; }
scp -q "$repo/deploy/remote.py" "$repo/deploy/nginx.py" "$host:$remote_tmp/"
if [[ $rollback == false ]]; then
  scp -q "$local_tmp/source.tar.gz" "$host:$remote_tmp/source.tar.gz"
  forward+=(--archive "$remote_tmp/source.tar.gz" --release "$revision" --sha256 "$checksum")
fi
if [[ -n $env_file ]]; then
  [[ -f $env_file ]] || { echo 'Private env file not found.' >&2; exit 2; }
  scp -q "$env_file" "$host:$remote_tmp/runtime.env"
  forward+=(--env-upload "$remote_tmp/runtime.env")
fi
if [[ -n $password_file ]]; then
  [[ -f $password_file ]] || { echo 'Password file not found.' >&2; exit 2; }
  scp -q "$password_file" "$host:$remote_tmp/password"
  forward+=(--password-upload "$remote_tmp/password")
fi
printf -v command '%q ' sudo -n python3 -B "$remote_tmp/remote.py" "${forward[@]}"
ssh "$host" "$command"
