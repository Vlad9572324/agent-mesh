"""Attended sessions must see the local CLI path even with an old tmux server."""

import os
import subprocess
import unittest
from unittest.mock import patch

from onboarding import mesh_connect


class MeshConnectPathTest(unittest.TestCase):
    def test_new_session_receives_provider_path(self):
        calls = []
        sessions_checked = 0

        def fake_tmux(_binary, *args, **_kwargs):
            nonlocal sessions_checked
            calls.append(args)
            if args[0] == "has-session":
                sessions_checked += 1
                rc = 1 if sessions_checked == 1 else 0
            else:
                rc = 0
            return subprocess.CompletedProcess(args, rc, "")

        with patch.object(mesh_connect, "tmux_run", side_effect=fake_tmux), patch.object(mesh_connect.time, "sleep"):
            with patch.dict(os.environ, {"PATH": "/root/.local/bin:/usr/bin"}):
                created = mesh_connect.prepare_session(
                    "/usr/bin/tmux", "mesh-example", {"agent_id": "example", "bundle": "/private/bundle"},
                    ["/usr/bin/python3", "connect.py"])

        self.assertTrue(created)
        create = next(args for args in calls if args[0] == "new-session")
        self.assertEqual(create[create.index("-e") + 1], "PATH=/root/.local/bin:/usr/bin")
        self.assertTrue(create[create.index("-e") + 2].endswith("/env"))
        self.assertEqual(create[create.index("-e") + 3], "PATH=/root/.local/bin:/usr/bin")
        self.assertEqual(create[-2:], ("/usr/bin/python3", "connect.py"))

    def test_provider_exit_during_startup_is_not_reported_as_running(self):
        def fake_tmux(_binary, *args, **_kwargs):
            return subprocess.CompletedProcess(args, 1 if args[0] == "has-session" else 0, "")

        with patch.object(mesh_connect, "tmux_run", side_effect=fake_tmux), patch.object(mesh_connect.time, "sleep"):
            with self.assertRaisesRegex(mesh_connect.ClientError, "provider exited during startup"):
                mesh_connect.prepare_session(
                    "/usr/bin/tmux", "mesh-example", {"agent_id": "example", "bundle": "/private/bundle"},
                    ["/usr/bin/python3", "connect.py"])

    def test_new_session_receives_proxy_environment(self):
        calls = []

        def fake_tmux(_binary, *args, **_kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 1 if args[0] == "has-session" and len(calls) == 1 else 0, "")

        with patch.object(mesh_connect, "tmux_run", side_effect=fake_tmux), patch.object(mesh_connect.time, "sleep"):
            with patch.dict(os.environ, {"PATH": "/usr/bin", "HTTPS_PROXY": "http://127.0.0.1:18109",
                                         "HTTP_PROXY": "http://127.0.0.1:18109",
                                         "ALL_PROXY": "socks5h://127.0.0.1:1080"}, clear=True):
                mesh_connect.prepare_session(
                    "/usr/bin/tmux", "mesh-example", {"agent_id": "example", "bundle": "/private/bundle"},
                    ["/usr/bin/python3", "connect.py"])

        create = next(args for args in calls if args[0] == "new-session")
        self.assertIn("HTTPS_PROXY=http://127.0.0.1:18109", create)
        self.assertIn("HTTP_PROXY=http://127.0.0.1:18109", create)
        self.assertIn("ALL_PROXY=socks5h://127.0.0.1:1080", create)
        self.assertEqual(create.count("-e"), 4)


if __name__ == "__main__":
    unittest.main()
