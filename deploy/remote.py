#!/usr/bin/env python3
"""Linux release deployment. Invoked over SSH by scripts/deploy-liveui.sh."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from nginx import install_include, snippet


def run(args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def atomic_write(file, content, mode=0o600):
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.' + file.name, dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream: stream.write(content)
        os.chmod(temp, mode)
        os.replace(temp, file)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def activate(link, target):
    temp = link.with_name('.current-' + str(os.getpid()))
    temp.unlink(missing_ok=True)
    if target:
        temp.symlink_to(target, target_is_directory=True)
        os.replace(temp, link)
    else: link.unlink(missing_ok=True)


def safe_path(value):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in value.split('/'):
        raise ValueError('Paths must be absolute, without spaces or parent traversal')
    return pathlib.Path(value)


def deployment_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / '.deploy.lock').open('a')
    try: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('Another deployment or rollback is already running')
    return lock


def healthy(port, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                data = json.load(response)
            if data.get('status') == 'ok' and data.get('service') == 'liveuiagent':
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=2) as response:
                    if response.status == 200 and len(response.read(4096)) > 200: return
        except Exception: pass
        time.sleep(1)
    raise RuntimeError('Readiness failed: application health/frontend did not become ready')


def snapshot(files, directory):
    directory.mkdir(mode=0o700, parents=True)
    records = []
    for index, file in enumerate(files):
        if file.is_symlink(): raise ValueError('Managed files must resolve to regular files before deployment')
        record = {'path': str(file), 'exists': file.exists()}
        if file.exists():
            stat = file.stat()
            record.update(mode=stat.st_mode & 0o777, uid=stat.st_uid, gid=stat.st_gid, backup=str(directory / str(index)))
            atomic_write(record['backup'], file.read_bytes())
        records.append(record)
    return records


def restore_files(records):
    for record in records:
        file = pathlib.Path(record['path'])
        if record['exists']:
            atomic_write(file, pathlib.Path(record['backup']).read_bytes(), record['mode'])
            os.chown(file, record['uid'], record['gid'])
        else: file.unlink(missing_ok=True)


def restore(state):
    restore_files(state['files'])
    activate(pathlib.Path(state['current']), state['previous'])
    run(['systemctl', 'daemon-reload'])
    if state['was_active']: run(['systemctl', 'restart', state['service']])
    else: run(['systemctl', 'stop', state['service']])
    if not state['was_enabled']: subprocess.run(['systemctl', 'disable', state['service']], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])
    if state['was_active']: healthy(state['port'], 60)


def bootstrap():
    if not pathlib.Path('/etc/debian_version').exists(): raise RuntimeError('--bootstrap supports Debian/Ubuntu only')
    run(['apt-get', 'update'])
    packages = ['ca-certificates', 'curl', 'xz-utils', 'nginx', 'openssl', 'build-essential', 'python3', 'libnss3', 'libnspr4', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2', 'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1', 'libpango-1.0-0', 'libcairo2', 'libatspi2.0-0', 'fonts-liberation']
    available = subprocess.run(['apt-cache', 'show', 'libasound2t64'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    packages.append('libasound2t64' if available else 'libasound2')
    run(['apt-get', 'install', '-y', '--no-install-recommends', *packages])


def node22(allow_install):
    node = shutil.which('node')
    if node and run([node, '-p', 'process.versions.node.split(".")[0]'], capture_output=True, text=True).stdout.strip() == '22': return node
    installed = pathlib.Path('/opt/liveui-node-22.22.2/bin/node')
    if installed.exists(): return str(installed)
    if not allow_install: raise RuntimeError('Node.js 22 is required; install it or run with --bootstrap')
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if not arch: raise RuntimeError('Unsupported Node architecture')
    name = f'node-v22.22.2-linux-{arch}.tar.xz'
    base = 'https://nodejs.org/dist/v22.22.2/'
    with tempfile.TemporaryDirectory(prefix='liveui-node-') as temp:
        archive = pathlib.Path(temp) / name
        urllib.request.urlretrieve(base + name, archive)
        checksums = urllib.request.urlopen(base + 'SHASUMS256.txt').read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected: raise RuntimeError('Node archive checksum mismatch')
        with tarfile.open(archive) as tar: tar.extractall(temp, filter='data')
        shutil.move(str(pathlib.Path(temp) / name.removesuffix('.tar.xz')), installed.parent.parent)
    return str(installed)


def service_unit(args, node, config, browser):
    values = {'LIVEUI_RUNTIME_ENV': str(config), 'LIVEUI_SHARED_DIR': str(args.root / 'shared'), 'LIVEUI_PORT': str(args.port), 'LIVEUI_BROWSER_PATH': browser}
    environment = '\n'.join('Environment="' + key + '=' + value.replace('\\', '\\\\').replace('"', '\\"') + '"' for key, value in values.items())
    return f'''[Unit]
Description=LiveUIAgent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User={args.user}
WorkingDirectory={args.root}/current
{environment}
ExecStart={node} {args.root}/current/deploy/runtime.mjs start
Restart=on-failure
RestartSec=3
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
'''


def deploy(args):
    if args.bootstrap: bootstrap()
    node = node22(args.bootstrap)
    account = pwd.getpwnam(args.user)
    if account.pw_uid == 0: raise ValueError('The application must run as an unprivileged existing user')
    root, shared = args.root, args.root / 'shared'
    current = root / 'current'
    if current.exists() and not current.is_symlink(): raise ValueError('current must be a release symlink; existing directories will not be replaced')
    root.mkdir(parents=True, exist_ok=True)
    for directory in [shared, shared / 'data', shared / 'generated-apps', shared / 'evaluations', shared / 'browsers', shared / 'configs']:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(directory, account.pw_uid, account.pw_gid)
    release = root / 'releases' / args.release
    if hashlib.sha256(args.archive.read_bytes()).hexdigest() != args.sha256: raise ValueError('Source archive checksum mismatch')
    if not (release / '.built').exists():
        if current.is_symlink() and current.resolve() == release.resolve():
            raise RuntimeError('Refusing to rebuild the active release in place')
        if release.exists(): shutil.rmtree(release)
        release.mkdir(parents=True)
        with tarfile.open(args.archive) as tar: tar.extractall(release, filter='data')
        run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}', release])
        environment = {'HOME': account.pw_dir, 'USER': args.user, 'PATH': str(pathlib.Path(node).parent) + ':/usr/local/bin:/usr/bin:/bin', 'CI': 'true'}
        npm = pathlib.Path(node).with_name('npm')
        run(['runuser', '-u', args.user, '--', 'env', *[k + '=' + v for k, v in environment.items()], npm, 'ci', '--workspace', 'packages/app-spec', '--workspace', 'packages/dsh-plugin', '--include-workspace-root', '--no-audit', '--no-fund'], cwd=release)
        run(['runuser', '-u', args.user, '--', 'env', *[k + '=' + v for k, v in environment.items()], npm, 'run', 'build'], cwd=release)
        atomic_write(release / '.built', args.release.encode(), 0o644)
    source_configs = list(args.remote_env or []) + ([args.env_upload] if args.env_upload else [])
    if not source_configs or any(not file.is_file() for file in source_configs): raise ValueError('Provide --remote-env or --env-file containing private model configuration')
    # Keep the original root-only env file unchanged. Each activation gets its own
    # private snapshot so rollback restores the old configuration as well as code.
    config = shared / 'configs' / (args.release + '-' + str(time.time_ns()) + '.env')
    atomic_write(config, b'\n'.join(file.read_bytes() for file in source_configs) + b'\n')
    os.chown(config, account.pw_uid, account.pw_gid)
    prepare_env = {'HOME': account.pw_dir, 'PATH': str(pathlib.Path(node).parent) + ':/usr/bin:/bin', 'LIVEUI_RUNTIME_ENV': str(config), 'LIVEUI_SHARED_DIR': str(shared), 'LIVEUI_PORT': str(args.port)}
    if args.chrome_path: prepare_env['LIVEUI_BROWSER_PATH'] = args.chrome_path
    result = run(['runuser', '-u', args.user, '--', 'env', *[k + '=' + v for k, v in prepare_env.items()], node, release / 'deploy/runtime.mjs', 'prepare-browser'], capture_output=True, text=True, cwd=release)
    browser = result.stdout.strip().splitlines()[-1]
    safe_path(browser)
    auth_file = args.auth_file or pathlib.Path('/etc/nginx') / (args.service + '.htpasswd')
    if not args.password_upload and not auth_file.is_file(): raise ValueError('Provide an existing --auth-file, or --auth-user and --password-file for first installation')
    site = args.nginx_site.resolve(strict=True)
    snippet_file = pathlib.Path('/etc/nginx/snippets') / (args.service + '.conf')
    unit = pathlib.Path('/etc/systemd/system') / (args.service + '.service')
    updated_site = install_include(site.read_text(), str(snippet_file), args.server_name)
    managed = [unit, snippet_file, site] + ([auth_file] if args.password_upload else [])
    transaction = root / 'transactions' / (str(time.time_ns()) + '-' + args.release[:12])
    state = {'current': str(current), 'previous': str(current.resolve()) if current.exists() else None, 'service': args.service, 'port': args.port, 'files': snapshot(managed, transaction), 'was_active': subprocess.run(['systemctl', 'is-active', '--quiet', args.service]).returncode == 0, 'was_enabled': subprocess.run(['systemctl', 'is-enabled', '--quiet', args.service]).returncode == 0}
    atomic_write(transaction / 'state.json', json.dumps(state).encode())
    try:
        if args.password_upload:
            password = args.password_upload.read_bytes().rstrip(b'\r\n')
            if not password or b'\n' in password or b'\r' in password: raise ValueError('Password file must contain one nonempty line')
            hashed = run(['openssl', 'passwd', '-6', '-stdin'], input=password, capture_output=True).stdout.strip()
            atomic_write(auth_file, args.auth_user.encode() + b':' + hashed + b'\n', 0o640)
            import grp
            os.chown(auth_file, 0, grp.getgrnam('www-data').gr_gid)
        atomic_write(snippet_file, snippet(args.port, str(auth_file)).encode(), 0o644)
        atomic_write(site, updated_site.encode(), site.stat().st_mode & 0o777)
        atomic_write(unit, service_unit(args, node, config, browser).encode(), 0o644)
        run(['nginx', '-t'])
        activate(current, release)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', args.service])
        run(['systemctl', 'restart', args.service])
        healthy(args.port, args.timeout)
        run(['systemctl', 'is-active', '--quiet', args.service])
        run(['systemctl', 'reload', 'nginx'])
    except Exception:
        print('Deployment failed; restoring previous release and proxy configuration.', file=sys.stderr)
        restore(state)
        raise
    atomic_write(root / 'rollback.json', json.dumps(state).encode())
    print(json.dumps({'status': 'ready', 'release': args.release, 'basePath': '/liveui/', 'bind': f'127.0.0.1:{args.port}', 'previous': state['previous']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='/srv/liveuiagent', type=safe_path)
    parser.add_argument('--user', default=os.environ.get('SUDO_USER', ''))
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--service', default='liveuiagent')
    parser.add_argument('--release')
    parser.add_argument('--archive', type=pathlib.Path)
    parser.add_argument('--sha256')
    parser.add_argument('--remote-env', type=safe_path, action='append', default=[])
    parser.add_argument('--env-upload', type=pathlib.Path)
    parser.add_argument('--nginx-site', type=safe_path)
    parser.add_argument('--server-name')
    parser.add_argument('--auth-file', type=safe_path)
    parser.add_argument('--auth-user')
    parser.add_argument('--password-upload', type=pathlib.Path)
    parser.add_argument('--chrome-path')
    parser.add_argument('--timeout', type=int, default=90)
    parser.add_argument('--bootstrap', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0: raise RuntimeError('Remote deployment requires sudo; application execution remains unprivileged')
    if len(args.root.parts) < 3 or not re.fullmatch(r'[a-z][a-z0-9_-]{0,40}', args.service): raise ValueError('Invalid installation root or service name')
    lock = deployment_lock(args.root)
    if args.rollback:
        state = json.loads((args.root / 'rollback.json').read_text())
        restore(state); print('Previous application release and proxy configuration restored. User data was preserved.'); return
    if not re.fullmatch(r'[a-f0-9]{40,64}', args.release or '') or not args.archive or not args.nginx_site or not (1024 <= args.port <= 65535): raise ValueError('Release/archive/nginx-site and an unprivileged port are required')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', args.user): raise ValueError('Provide an existing unprivileged --user')
    if args.password_upload and not re.fullmatch(r'[A-Za-z0-9_.-]{1,60}', args.auth_user or ''): raise ValueError('--password-file requires a safe --auth-user')
    deploy(args)


if __name__ == '__main__':
    try: main()
    except subprocess.CalledProcessError as error:
        # Do not dump argv or captured output: configuration values stay private.
        print(f'Deployment command failed with exit status {error.returncode}.', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
