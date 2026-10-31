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

    def update_preferences():
        result = adb('exec-out', 'run-as', PACKAGE, 'cat', 'shared_prefs/ulemi_updates.xml', check=False)
        if result.returncode != 0:
            return {}
        return {node.attrib['name']: node.text if node.tag == 'string' else node.attrib.get('value') for node in ET.fromstring(result.stdout)}

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
        raise RuntimeError('Expected visible enabled button was not found: ' + label)

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
            if args.require_confirmation:
                pending_deadline = time.monotonic() + 45
                pending = {}
                while time.monotonic() < pending_deadline:
                    pending = update_preferences()
                    if pending.get('install_status') == 'confirmation_required':
                        break
                    time.sleep(1)
                if pending.get('install_status') != 'confirmation_required':
                    raise RuntimeError('Android 11 did not deliver the real pending-user-action callback')
                original_session = pending['session_id']
                # Complete the test instrumentation, then open the ordinary app prompt.
                process.wait(timeout=15)
                adb('shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity')
                tap_button({'UPDATE NOW'}, {PACKAGE}, 'app-update-ready')
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
    (args.output / 'verification.json').write_text(json.dumps({'passed': True, 'realPackageInstaller': True, 'adbUsedToInstallUpdate': False, 'systemUserConfirmation': args.require_confirmation, 'evidence': evidence}, indent=2))
    print('Actual PackageInstaller self-update and persistent data verification passed.')


if __name__ == '__main__':
    main()
