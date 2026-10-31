#!/usr/bin/env python3
"""Run the app's real PackageInstaller self-update; adb only installs the old APK."""
import argparse
import json
import pathlib
import subprocess
import time

PACKAGE = 'com.stonezhang.liveui'
RUNNER = PACKAGE + '.test/' + PACKAGE + '.UpdateFlowTests'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    def adb(*cmd, data=None, timeout=60, check=True):
        return subprocess.run(['adb', *cmd], input=data, capture_output=True, timeout=timeout, check=check)

    def phase(name):
        run = adb('shell', 'am', 'instrument', '-w', '-e', 'phase', name, RUNNER, timeout=120)
        output = run.stdout.decode(errors='replace') + run.stderr.decode(errors='replace')
        (args.output / (name + '.log')).write_text(output)
        if 'UPDATE_TEST_OK ' + name not in output:
            raise RuntimeError('Instrumentation did not pass: ' + name)

    # These are the only adb installs. The update itself goes through production app code.
    adb('install', '--no-incremental', str(args.fixtures / 'old.apk'))
    adb('install', '--no-incremental', str(args.fixtures / 'tests.apk'))
    adb('shell', 'run-as', PACKAGE, 'mkdir', '-p', 'files')
    for source, destination in [('new.apk', 'next'), ('wrong-signer.apk', 'wrong-signer'), ('old.apk', 'old'), ('tests.apk', 'other-package')]:
        command = 'cat > files/update-test-' + destination + '.apk'
        adb('shell', '-T', 'run-as', PACKAGE, 'sh', '-c', "'" + command + "'", data=(args.fixtures / source).read_bytes(), timeout=120)
    phase('validate')
    adb('shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'deny')
    phase('blocked')
    adb('shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow')

    with (args.output / 'install.log').open('wb') as log:
        process = subprocess.Popen(['adb', 'shell', 'am', 'instrument', '-w', '-e', 'phase', 'install', RUNNER], stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 120
        installed = False
        try:
            while time.monotonic() < deadline:
                package = adb('shell', 'dumpsys', 'package', PACKAGE, timeout=20).stdout.decode(errors='replace')
                if 'versionCode=1002 ' in package:
                    (args.output / 'installed-package.txt').write_text(package)
                    installed = True
                    break
                time.sleep(2)
            if not installed:
                (args.output / 'installer-logcat.txt').write_bytes(adb('logcat', '-d', '-s', 'PackageInstaller', 'PackageInstallerSession', 'PackageManager', timeout=30).stdout)
                raise RuntimeError('Self-update did not install version 1002; no adb update or UI bypass attempted')
        finally:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
    # A fresh process verifies the OS-installed version and persistent state.
    phase('verify')
    evidence = {}
    for name in ['validate', 'blocked', 'requested', 'committed', 'verify']:
        result = adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/update-test-' + name + '.json', check=False)
        if result.returncode == 0:
            evidence[name] = json.loads(result.stdout)
    assert evidence['verify']['installedVersion'] == 1002
    assert evidence['verify']['passed'] is True
    (args.output / 'verification.json').write_text(json.dumps({'passed': True, 'realPackageInstaller': True, 'adbUsedToInstallUpdate': False, 'evidence': evidence}, indent=2))
    print('Actual PackageInstaller self-update and persistent data verification passed.')


if __name__ == '__main__':
    main()
