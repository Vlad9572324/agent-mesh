import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import native_launch


class NativeLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_path = self.root / 'connection.json'
        self.config = {'runtime': 'codex', 'workspace_root': str(self.root),
                       'state_dir': str(self.root / 'state')}
        native_launch.private_json(self.config_path, self.config)

    def test_codex_additive_invocation_no_trust_bypass_or_home_override(self):
        with patch('native_launch.shutil.which', return_value='/fake/codex'):
            launch = native_launch.build_launch(self.config_path, self.config, cli_args=('exec', '--json', 'hello'))
        argv = launch['argv']
        self.assertEqual(argv[1], 'exec')
        self.assertEqual(argv[-2:], ['--json', 'hello'])
        self.assertIn('mcp_servers.agent_link_native=', ' '.join(argv))
        self.assertIn('"required" = true', argv[3])
        self.assertNotIn('--dangerously-bypass-hook-trust', argv)
        self.assertNotIn('hooks.Notification=', ' '.join(argv))
        self.assertNotIn('hooks.PostToolUseFailure=', ' '.join(argv))
        self.assertEqual(launch['env'].get('CODEX_HOME'), os.environ.get('CODEX_HOME'))
        self.assertEqual(launch['env'].get('HOME'), os.environ.get('HOME'))
        self.assertEqual(os.stat(Path(launch['launch_dir']) / 'launch.json').st_mode & 0o777, 0o600)
        metadata = (Path(launch['launch_dir']) / 'launch.json').read_text()
        self.assertNotIn('hello', metadata)
        self.assertNotIn('argv', json.loads(metadata))

    def test_codex_exec_keeps_native_and_user_overrides_on_same_command(self):
        for command in ('exec', 'e'):
            with patch('native_launch.shutil.which', return_value='/fake/codex'):
                launch = native_launch.build_launch(self.config_path, self.config, cli_args=(
                    command, '--ignore-user-config', '-c', 'web_search="disabled"', '-'))
            self.assertEqual(launch['argv'][1:3], [command, '-c'])
            self.assertTrue(launch['argv'][3].startswith('mcp_servers.agent_link_native='))
            self.assertIn('web_search="disabled"', launch['argv'])

    def test_codex_resume_fork_review_overrides_are_on_leaf_command(self):
        for prefix in (['resume'], ['fork'], ['review'], ['exec', 'resume'], ['exec', 'fork'], ['e', 'review']):
            with patch('native_launch.shutil.which', return_value='/fake/codex'):
                launch = native_launch.build_launch(self.config_path, self.config, cli_args=(
                    *prefix, '-c', 'web_search="disabled"'))
            self.assertEqual(launch['argv'][1:1+len(prefix)], prefix)
            self.assertEqual(launch['argv'][1+len(prefix)], '-c')
            self.assertTrue(launch['argv'][2+len(prefix)].startswith('mcp_servers.agent_link_native='))

    def test_codex_session_end_uses_supported_three_second_timeout(self):
        self.assertEqual(native_launch.hook_definitions(self.config_path, 'codex')['SessionEnd'][0]['hooks'][0]['timeout'], 3)

    def test_codex_rejects_workspace_override(self):
        for tail in (['--cd', '/other'], ['-C/other'], ['--cd=/other']):
            with self.assertRaises(ValueError):
                native_launch.build_launch(self.config_path, self.config, cli_args=tail)

    def test_claude_private_native_configs_preserve_settings_sources(self):
        self.config['runtime'] = 'claude'
        with patch('native_launch.shutil.which', return_value='/fake/claude'):
            launch = native_launch.build_launch(self.config_path, self.config)
        directory = Path(launch['launch_dir'])
        settings = json.loads((directory / 'settings.json').read_text())
        self.assertIn('PostToolUseFailure', settings['hooks'])
        self.assertIn('Notification', settings['hooks'])
        self.assertNotIn('--strict-mcp-config', launch['argv'])
        self.assertNotIn('--setting-sources', launch['argv'])
        instructions = launch['argv'][launch['argv'].index('--append-system-prompt') + 1]
        self.assertIn('link_peers to discover actual recipient IDs', instructions)
        self.assertIn('nonempty recipient_ids', instructions)
        self.assertIn('link_broadcast only intentionally', instructions)
        self.assertIn('no native inbox delivery', instructions)
        self.assertIn('explicitly with link_inbox', instructions)
        mcp = json.loads((directory / 'mcp.json').read_text())['mcpServers']['agent_link_native']
        self.assertEqual(mcp['env']['AGENT_LINK_NATIVE_SESSION_ID'], launch['native_session_id'])
        self.assertEqual(launch['env']['AGENT_LINK_NATIVE_CONFIG'], str(self.config_path))
        self.assertEqual(launch['env']['AGENT_LINK_ARTIFACT_CLI'],
                         str(native_launch.ROOT / 'scripts/agent-link-artifacts.py'))

    def test_claude_scoped_mcp_allowlist_without_bypass(self):
        self.config['runtime'] = 'claude'
        tools = ('mcp__agent_link_native__link_inbox', 'mcp__agent_link_native__link_send')
        with patch('native_launch.shutil.which', return_value='/fake/claude'):
            launch = native_launch.build_launch(self.config_path, self.config, mcp_allowlist=tools)
        settings = json.loads((Path(launch['launch_dir']) / 'settings.json').read_text())
        self.assertEqual(settings['permissions']['allow'], list(tools))
        self.assertNotIn('defaultMode', settings['permissions'])
        serialized = json.dumps(settings) + ' '.join(launch['argv'])
        for banned in ('bypassPermissions', 'acceptEdits', '--dangerously-skip-permissions'):
            self.assertNotIn(banned, serialized)

    def test_claude_without_allowlist_has_no_permissions_block(self):
        self.config['runtime'] = 'claude'
        with patch('native_launch.shutil.which', return_value='/fake/claude'):
            launch = native_launch.build_launch(self.config_path, self.config)
        settings = json.loads((Path(launch['launch_dir']) / 'settings.json').read_text())
        self.assertNotIn('permissions', settings)

    def test_mcp_allowlist_rejects_unscoped_or_bypass_rules(self):
        self.config['runtime'] = 'claude'
        for bad in (('*',), ('Bash',), ('mcp__other__x',), ('mcp__agent_link_native__',),
                    ('mcp__agent_link_native__link-inbox',), ('bypassPermissions',), ()):
            with patch('native_launch.shutil.which', return_value='/fake/claude'):
                with self.assertRaises(ValueError):
                    native_launch.build_launch(self.config_path, self.config, mcp_allowlist=bad)

    def test_mcp_allowlist_rejected_for_codex_runtime(self):
        with self.assertRaises(ValueError):
            native_launch.build_launch(self.config_path, self.config,
                                       mcp_allowlist=('mcp__agent_link_native__link_inbox',))

    def test_ids_are_per_invocation(self):
        with patch('native_launch.shutil.which', return_value='/fake/codex'):
            first = native_launch.build_launch(self.config_path, self.config)
            second = native_launch.build_launch(self.config_path, self.config)
        self.assertNotEqual(first['native_session_id'], second['native_session_id'])
        self.assertNotEqual(first['launch_dir'], second['launch_dir'])

    def test_explicit_provider_executable_is_absolute_regular_and_pinned(self):
        executable = self.root / 'provider'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o700)
        launch = native_launch.build_launch(
            self.config_path, self.config, executable=str(executable))
        self.assertEqual(launch['argv'][0], str(executable))
        with self.assertRaisesRegex(ValueError, 'absolute executable'):
            native_launch.build_launch(self.config_path, self.config, executable='relative')

    def test_hook_command_quotes_paths(self):
        import shlex
        path = self.root / 'has space; not shell.json'
        command = native_launch.hook_definitions(path, 'claude')['PreToolUse'][0]['hooks'][0]['command']
        self.assertIn(str(path), shlex.split(command))

    def test_private_files_refuse_overwrite(self):
        with self.assertRaises(FileExistsError):
            native_launch.private_json(self.config_path, {'changed': True})

    def test_private_directory_refuses_symlink_or_broad_access(self):
        bad = self.root / 'bad'
        bad.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            native_launch.private_dir(bad)
        public = self.root / 'public'
        public.mkdir(mode=0o755)
        public.chmod(0o755)
        with self.assertRaises(ValueError):
            native_launch.private_dir(public)

    def test_toml_escaping(self):
        self.assertEqual(native_launch.toml('a"b\\c'), json.dumps('a"b\\c'))
        self.assertEqual(native_launch.toml({'env': {'ID': 'test'}}), '{"env" = {"ID" = "test"}}')

    def test_doorbell_supervisor_uses_exact_tmux_pane_and_stops_with_provider(self):
        calls = []

        class Process:
            def __init__(self, role):
                self.role = role
                self.terminated = self.killed = False

            def wait(self, timeout=None):
                calls.append((self.role, "wait", timeout))
                return 7 if self.role == "provider" else 0

            def terminate(self):
                self.terminated = True
                calls.append((self.role, "terminate", None))

            def kill(self):
                self.killed = True

        processes = []

        def popen(argv, **kwargs):
            role = "doorbell" if "agent-link-doorbell.py" in " ".join(argv) else "provider"
            process = Process(role)
            processes.append((argv, kwargs, process))
            return process

        launch = {'argv': ['/fake/codex'], 'cwd': str(self.root), 'env': {'SAFE': '1'}}
        self.assertEqual(native_launch.run_with_doorbell(launch, self.config_path, '%7', popen=popen), 7)
        self.assertEqual([p[2].role for p in processes], ['doorbell', 'provider'])
        self.assertIn('%7', processes[0][0])
        self.assertIn(str(self.config_path), processes[0][0])
        self.assertEqual(processes[0][1]['stdin'], subprocess.DEVNULL)
        self.assertEqual(processes[0][1]['stdout'], subprocess.DEVNULL)
        self.assertEqual(processes[0][1]['stderr'], subprocess.DEVNULL)
        self.assertNotIn('stdout', processes[1][1])
        self.assertTrue(processes[0][2].terminated)
        self.assertIn(('doorbell', 'wait', 5), calls)

    def test_doorbell_supervisor_rejects_untrusted_target_before_start(self):
        with self.assertRaises(ValueError):
            native_launch.run_with_doorbell({}, self.config_path, 'session:0', popen=lambda *a, **k: None)

    def test_supervisor_does_not_start_provider_after_a_stop_in_the_launch_window(self):
        # Drive the actual installed signal handler in the window after the
        # doorbell starts but before the provider is spawned: the provider must
        # never start, and the doorbell must be terminated and reaped.
        captured = {}

        def fake_signal(signum, handler):
            captured[signum] = handler
            return None

        created = []

        class Process:
            def __init__(self, role):
                self.role = role
                self.terminated = self.waited = False

            def wait(self, timeout=None):
                self.waited = True
                return 0

            def terminate(self):
                self.terminated = True

            def kill(self):
                pass

        def popen(argv, **kwargs):
            role = "doorbell" if "agent-link-doorbell.py" in " ".join(argv) else "provider"
            process = Process(role)
            created.append(process)
            if role == "doorbell":
                captured[native_launch.signal.SIGTERM](native_launch.signal.SIGTERM, None)  # stop lands here
            return process

        launch = {'argv': ['/fake/codex'], 'cwd': str(self.root), 'env': {}}
        with patch.object(native_launch.signal, 'signal', fake_signal):
            rc = native_launch.run_with_doorbell(launch, self.config_path, '%5', popen=popen)
        self.assertEqual([p.role for p in created], ['doorbell'])  # provider never spawned after the stop
        self.assertTrue(created[0].terminated and created[0].waited)  # doorbell stopped and reaped
        self.assertEqual(rc, 0)

    def test_doorbell_supervisor_stops_both_children_when_interrupted(self):
        # A signal delivered while the supervisor waits surfaces as an interrupt in
        # provider.wait(); both the provider and the doorbell must still be stopped,
        # never left orphaned.
        processes = []

        class Process:
            def __init__(self, role):
                self.role = role
                self.terminated = self.waited = False

            def wait(self, timeout=None):
                if self.role == "provider" and timeout is None:
                    raise KeyboardInterrupt  # stand-in for a terminating signal
                self.waited = True
                return 0

            def terminate(self):
                self.terminated = True

            def kill(self):
                pass

        def popen(argv, **kwargs):
            process = Process("doorbell" if "agent-link-doorbell.py" in " ".join(argv) else "provider")
            processes.append(process)
            return process

        launch = {'argv': ['/fake/codex'], 'cwd': str(self.root), 'env': {}}
        with self.assertRaises(KeyboardInterrupt):
            native_launch.run_with_doorbell(launch, self.config_path, '%3', popen=popen)
        self.assertEqual([p.role for p in processes], ['doorbell', 'provider'])
        self.assertTrue(all(p.terminated for p in processes), "both children must be terminated")
        self.assertTrue(all(p.waited for p in processes), "both children must be reaped")


if __name__ == '__main__':
    unittest.main()
