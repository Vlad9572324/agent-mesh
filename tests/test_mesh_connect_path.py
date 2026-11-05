"""Attended sessions must see the local CLI path even with an old tmux server."""

import os
import subprocess
import unittest
from unittest.mock import patch

from onboarding import mesh_connect


class MeshConnectPathTest(unittest.TestCase):
    def test_new_session_receives_provider_path(self):
        calls = []

        def fake_tmux(_binary, *args, **_kwargs):
            calls.append(args)
            rc = 1 if args[0] == "has-session" else 0
            return subprocess.CompletedProcess(args, rc, "")

        with patch.object(mesh_connect, "tmux_run", side_effect=fake_tmux):
            with patch.dict(os.environ, {"PATH": "/root/.local/bin:/usr/bin"}):
                created = mesh_connect.prepare_session(
                    "/usr/bin/tmux", "mesh-example", {"agent_id": "example", "bundle": "/private/bundle"},
                    ["/usr/bin/python3", "connect.py"])

        self.assertTrue(created)
        create = next(args for args in calls if args[0] == "new-session")
        self.assertEqual(create[create.index("-e") + 1], "PATH=/root/.local/bin:/usr/bin")
        self.assertEqual(create[-2:], ("/usr/bin/python3", "connect.py"))


if __name__ == "__main__":
    unittest.main()
