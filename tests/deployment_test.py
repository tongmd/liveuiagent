import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'deploy'))
import nginx
import remote


class ProxyTests(unittest.TestCase):
    def test_only_liveui_locations_change_and_second_deploy_is_identical(self):
        source = '''# existing production site
server {
 listen 80;
 server_name example.org;
 location / { proxy_pass http://127.0.0.1:8787; }
 location = /liveui { return 302 /old; }
 location ^~ /liveui/ { proxy_pass http://127.0.0.1:9999; }
 location /dsh/ { proxy_pass http://127.0.0.1:8790; }
 location /liveui-other { return 200 "unchanged { # }"; }
}
server { listen 443 ssl; server_name untouched.example; location / { return 204; } }
'''
        output = nginx.install_include(source, '/etc/nginx/snippets/liveuiagent.conf', 'example.org')
        self.assertIn('location / { proxy_pass http://127.0.0.1:8787; }', output)
        self.assertIn('location /dsh/ { proxy_pass http://127.0.0.1:8790; }', output)
        self.assertIn('location /liveui-other { return 200 "unchanged { # }"; }', output)
        self.assertIn('server { listen 443 ssl; server_name untouched.example; location / { return 204; } }', output)
        self.assertNotIn('127.0.0.1:9999', output)
        self.assertEqual(output.count('include /etc/nginx/snippets/liveuiagent.conf;'), 1)
        self.assertEqual(nginx.install_include(output, '/etc/nginx/snippets/liveuiagent.conf', 'example.org'), output)

    def test_ambiguous_or_complex_sites_fail_without_guessing(self):
        with self.assertRaises(ValueError): nginx.install_include('server {} server {}', '/tmp/app.conf')
        with self.assertRaises(ValueError): nginx.install_include('server { location ~ ^/liveui/(.*)$ {} }', '/tmp/app.conf')
        with self.assertRaises(ValueError): nginx.install_include('server {', '/tmp/app.conf')

    def test_proxy_identity_and_mount_are_fixed_and_authenticated(self):
        value = nginx.snippet(8791, '/etc/nginx/app.htpasswd')
        self.assertIn('auth_basic_user_file /etc/nginx/app.htpasswd;', value)
        self.assertIn('proxy_set_header X-LiveUIAgent-User $remote_user;', value)
        self.assertIn('proxy_pass http://127.0.0.1:8791/;', value)
        self.assertIn('location ^~ /liveui/', value)
        self.assertIn('return 308 /liveui/$is_args$args;', value)
        self.assertIn('proxy_set_header Connection "";', value)
        self.assertNotIn('location / {', value)
        self.assertNotIn('$http_x_liveuiagent_user', value)
        with self.assertRaises(ValueError): nginx.snippet(80, '/tmp/auth')
        with self.assertRaises(ValueError): nginx.snippet(8791, '/tmp/../auth')


class RollbackTests(unittest.TestCase):
    def test_concurrent_deployments_are_rejected_then_lock_can_be_reacquired(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            with remote.deployment_lock(root):
                with self.assertRaisesRegex(RuntimeError, 'already running'):
                    remote.deployment_lock(root)
            with remote.deployment_lock(root): pass

    def test_failed_release_restores_code_proxy_and_unit_without_changing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            previous = base / 'old'; previous.mkdir()
            candidate = base / 'new'; candidate.mkdir()
            current = base / 'current'; current.symlink_to(previous)
            site = base / 'site.conf'; site.write_text('old proxy')
            unit = base / 'unit.service'; unit.write_text('old service')
            data = base / 'data.db'; data.write_bytes(b'user data written before and during release')
            records = remote.snapshot([site, unit], base / 'transaction')
            state = {'files': records, 'current': str(current), 'previous': str(previous), 'service': 'fixture', 'port': 8791, 'was_active': True, 'was_enabled': True}
            site.write_text('new proxy'); unit.write_text('new service'); remote.activate(current, candidate)
            with patch.object(remote, 'run') as run, patch.object(remote, 'healthy') as healthy:
                remote.restore(state)
            self.assertEqual(current.resolve(), previous.resolve())
            self.assertEqual(site.read_text(), 'old proxy')
            self.assertEqual(unit.read_text(), 'old service')
            self.assertEqual(data.read_bytes(), b'user data written before and during release')
            self.assertIn((['systemctl', 'restart', 'fixture'],), [call.args for call in run.call_args_list])
            healthy.assert_called_once_with(8791, 60)

    def test_first_deploy_rollback_removes_only_created_managed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory); unit = base / 'unit'; current = base / 'current'
            records = remote.snapshot([unit], base / 'transaction'); unit.write_text('created')
            current.symlink_to(base / 'candidate')
            state = {'files': records, 'current': str(current), 'previous': None, 'service': 'fixture', 'port': 8791, 'was_active': False, 'was_enabled': False}
            with patch.object(remote, 'run'), patch.object(remote.subprocess, 'run'):
                remote.restore(state)
            self.assertFalse(unit.exists()); self.assertFalse(current.is_symlink())

    def test_snapshot_rejects_symlinks_and_secret_backup_permissions_are_private(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory); file = base / 'private'; file.write_text('fixture-only')
            records = remote.snapshot([file], base / 'transaction')
            self.assertEqual(pathlib.Path(records[0]['backup']).stat().st_mode & 0o777, 0o600)
            link = base / 'link'; link.symlink_to(file)
            with self.assertRaises(ValueError): remote.snapshot([link], base / 'other')


if __name__ == '__main__': unittest.main()
