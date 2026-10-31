#!/usr/bin/env python3
"""Run the app's real PackageInstaller self-update; adb only installs the old APK."""
import argparse
import json
import pathlib
import subprocess
import time
import re
import xml.etree.ElementTree as ET

PACKAGE = 'com.stonezhang.liveui'
RUNNER = PACKAGE + '.test/' + PACKAGE + '.UpdateFlowTests'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixtures', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--require-confirmation', action='store_true')
    parser.add_argument('--background-ready', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    def adb(*cmd, data=None, timeout=60, check=True):
        result = subprocess.run(['adb', *cmd], input=data, capture_output=True, timeout=timeout, check=False)
        if check and result.returncode:
            (args.output / 'adb-failure.json').write_text(json.dumps({'command': list(cmd), 'returncode': result.returncode,
                'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}, indent=2))
            raise RuntimeError('adb command failed; see adb-failure.json')
        return result

    def collect_diagnostics():
        for name in ['public-manifest', 'validate', 'blocked', 'scheduler', 'background-ready', 'requested', 'committed', 'pending-callback', 'failure', 'verify']:
            result = adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/update-test-' + name + '.json', check=False)
            try:
                value = json.loads(result.stdout)
            except (ValueError, UnicodeDecodeError):
                continue
            (args.output / ('phase-' + name + '.json')).write_text(json.dumps(value, indent=2))
        safe = {key: value for key, value in update_preferences().items() if key in {'install_status', 'session_id', 'expected_version', 'last_check'}}
        (args.output / 'update-status.json').write_text(json.dumps(safe, indent=2))
        (args.output / 'package-sessions.txt').write_bytes(adb('shell', 'dumpsys', 'package', check=False).stdout)
        (args.output / 'full-logcat.txt').write_bytes(adb('logcat', '-d', check=False).stdout)

    def phase(name):
        run = adb('shell', 'am', 'instrument', '-w', '-e', 'phase', name, RUNNER, timeout=120, check=False)
        output = run.stdout.decode(errors='replace') + run.stderr.decode(errors='replace')
        (args.output / (name + '.log')).write_text(output)
        if run.returncode or 'UPDATE_TEST_OK ' + name not in output:
            (args.output / 'instrumentations.txt').write_bytes(adb('shell', 'pm', 'list', 'instrumentation', check=False).stdout)
            (args.output / 'crash-logcat.txt').write_bytes(adb('logcat', '-d', '-b', 'crash', check=False).stdout)
            collect_diagnostics()
            raise RuntimeError('Instrumentation did not pass: ' + name)

    def update_preferences():
        result = adb('exec-out', 'run-as', PACKAGE, 'cat', 'shared_prefs/ulemi_updates.xml', check=False)
        if result.returncode != 0:
            return {}
        try:
            root = ET.fromstring(result.stdout)
        except ET.ParseError:
            # API30 exec-out can return 0 for cat's "not found" while the app is
            # still creating its first preference file. The bounded poll must
            # wait for an actual complete pending callback, not treat this as one.
            return {}
        return {node.attrib['name']: node.text if node.tag == 'string' else node.attrib.get('value') for node in root}

    def tap_button(labels, packages, label):
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            adb('shell', 'uiautomator', 'dump', '/sdcard/update-ui.xml', timeout=20, check=False)
            response = adb('exec-out', 'cat', '/sdcard/update-ui.xml', check=False)
            try:
                root = ET.fromstring(response.stdout)
            except ET.ParseError:
                time.sleep(1)
                continue
            for node in root.iter('node'):
                if node.attrib.get('text', '').upper() not in labels or node.attrib.get('package') not in packages or node.attrib.get('enabled') != 'true':
                    continue
                values = [int(v) for v in re.findall(r'\d+', node.attrib.get('bounds', ''))]
                if len(values) != 4:
                    continue
                (args.output / (label + '.xml')).write_bytes(response.stdout)
                (args.output / (label + '.png')).write_bytes(adb('exec-out', 'screencap', '-p').stdout)
                adb('shell', 'input', 'tap', str((values[0] + values[2]) // 2), str((values[1] + values[3]) // 2))
                return
            time.sleep(1)
        (args.output / (label + '-timeout.xml')).write_bytes(adb('exec-out', 'cat', '/sdcard/update-ui.xml', check=False).stdout)
        (args.output / (label + '-timeout.png')).write_bytes(adb('exec-out', 'screencap', '-p', check=False).stdout)
        raise RuntimeError('Expected visible enabled button was not found: ' + label)

    # These are the only adb installs. The update itself goes through production app code.
    adb('install', '--no-incremental', str(args.fixtures / 'old.apk'))
    adb('install', '--no-incremental', str(args.fixtures / 'tests.apk'))
    adb('shell', 'run-as', PACKAGE, 'mkdir', '-p', 'files')
    for source, destination in [('new.apk', 'next'), ('wrong-signer.apk', 'wrong-signer'), ('old.apk', 'old'), ('tests.apk', 'other-package')]:
        command = 'cat > files/update-test-' + destination + '.apk'
        adb('shell', '-T', 'run-as', PACKAGE, 'sh', '-c', "'" + command + "'", data=(args.fixtures / source).read_bytes(), timeout=120)
    phase('public-manifest')
    phase('validate')
    adb('shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'deny')
    phase('blocked')
    adb('shell', 'appops', 'set', PACKAGE, 'REQUEST_INSTALL_PACKAGES', 'allow')

    if args.background_ready:
        phase('prepare-background')
        adb('shell', 'input', 'keyevent', 'HOME')
        # The emulator clock need not wait the entire job latency. This dispatches
        # the real production JobService after instrumentation has exited.
        install_command = ['adb', 'shell', 'cmd', 'jobscheduler', 'run', '-f', PACKAGE, '1284']
    else:
        install_command = ['adb', 'shell', 'am', 'instrument', '-w', '-e', 'phase', 'install', RUNNER]
    with (args.output / 'install.log').open('wb') as log:
        process = subprocess.Popen(install_command, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 120
        installed = False
        try:
            if args.require_confirmation:
                pending_deadline = time.monotonic() + 45
                pending = {}
                while time.monotonic() < pending_deadline:
                    pending = update_preferences()
                    if pending.get('install_status') == 'confirmation_required':
                        break
                    time.sleep(1)
                if pending.get('install_status') != 'confirmation_required':
                    safe = {key: value for key, value in pending.items() if key in {'install_status', 'session_id', 'expected_version'}}
                    (args.output / 'pending-timeout.json').write_text(json.dumps(safe, indent=2))
                    (args.output / 'pending-logcat.txt').write_bytes(adb('logcat', '-d', '-b', 'crash', check=False).stdout)
                    raise RuntimeError('Android 11 did not deliver the real pending-user-action callback')
                original_session = pending['session_id']
                (args.output / 'pending-received.json').write_text(json.dumps({k: pending[k] for k in ['install_status', 'session_id', 'expected_version'] if k in pending}, indent=2))
                # Complete the test instrumentation, then open the ordinary app prompt.
                process.wait(timeout=15)
                adb('shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity')
                tap_button({'UPDATE NOW'}, {PACKAGE}, 'app-update-ready')
                current = update_preferences()
                (args.output / 'after-app-confirmation.json').write_text(json.dumps({k: current[k] for k in ['install_status', 'session_id', 'expected_version'] if k in current}, indent=2))
                if update_preferences().get('session_id') != original_session:
                    raise RuntimeError('Opening saved confirmation replaced the original OS session')
                tap_button({'INSTALL'}, {'com.android.packageinstaller', 'com.google.android.packageinstaller'}, 'android-install-confirmation')
                (args.output / 'confirmation.json').write_text(json.dumps({'originalSession': original_session, 'originalSessionPreserved': True, 'systemUserConfirmation': True, 'appPromptUsed': True}, indent=2))
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
            collect_diagnostics()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=10)
    # A fresh process verifies the OS-installed version and persistent state.
    phase('verify')
    evidence = {}
    for name in ['public-manifest', 'validate', 'blocked', 'scheduler', 'background-ready', 'requested', 'committed', 'pending-callback', 'verify']:
        result = adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/update-test-' + name + '.json', check=False)
        if result.returncode == 0:
            evidence[name] = json.loads(result.stdout)
    assert evidence['verify']['installedVersion'] == 1002
    assert evidence['verify']['passed'] is True
    (args.output / 'verification.json').write_text(json.dumps({'passed': True, 'realPackageInstaller': True, 'adbUsedToInstallUpdate': False, 'systemUserConfirmation': args.require_confirmation, 'backgroundReadyJob': args.background_ready, 'schedulerDispatchedByAdb': args.background_ready, 'evidence': evidence}, indent=2))
    print('Actual PackageInstaller self-update and persistent data verification passed.')


if __name__ == '__main__':
    main()
