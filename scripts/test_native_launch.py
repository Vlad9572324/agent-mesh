import json
import os
from pathlib import Path
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

    def test_ids_are_per_invocation(self):
        with patch('native_launch.shutil.which', return_value='/fake/codex'):
            first = native_launch.build_launch(self.config_path, self.config)
            second = native_launch.build_launch(self.config_path, self.config)
        self.assertNotEqual(first['native_session_id'], second['native_session_id'])
        self.assertNotEqual(first['launch_dir'], second['launch_dir'])

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


if __name__ == '__main__':
    unittest.main()
