"""Offline validation of cross-host settings; never starts a network probe."""
import shlex
import unittest

from crossvm_artifacts import probe_settings, receiver_command


SETTINGS = {
    "AGENT_LINK_RUNTIME_DIR": "/var/tmp/agent-mesh-config-fixture",
    "AGENT_LINK_ORIGIN": "https://198.51.100.20:18773",
    "AGENT_LINK_CA_FILE": "/workspace-fixture/ca.crt",
    "AGENT_LINK_TEST_BIND_IP": "198.51.100.20",
    "AGENT_LINK_TEST_SSH_TARGET": "fixture@198.51.100.21",
    "AGENT_LINK_TEST_LXC_VMID": "9001",
    "AGENT_LINK_TEST_RECEIVER_HOSTNAME": "example-receiver",
    "AGENT_LINK_TEST_RECEIVER_MARKER_FILE": "/workspace-fixture/receiver-marker",
    "AGENT_LINK_TEST_RECEIVER_MARKER": "example-receiver-v1",
}


class OperatorTargetTests(unittest.TestCase):
    def test_explicit_targets_are_preserved(self):
        settings = probe_settings(SETTINGS)
        self.assertEqual(settings["bind_ip"], SETTINGS["AGENT_LINK_TEST_BIND_IP"])
        self.assertEqual(settings["origin"], SETTINGS["AGENT_LINK_ORIGIN"])
        self.assertEqual(settings["remote"], SETTINGS["AGENT_LINK_TEST_SSH_TARGET"])
        self.assertEqual(settings["port"], 18773)

    def test_each_setting_is_required(self):
        for name in SETTINGS:
            with self.subTest(name=name):
                env = dict(SETTINGS)
                del env[name]
                with self.assertRaisesRegex(ValueError, name):
                    probe_settings(env)

    def test_bind_must_match_owned_origin(self):
        for value in ["0.0.0.0", "127.0.0.1", "224.0.0.1", "198.51.100.22", "localhost", "::1"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe_settings({**SETTINGS, "AGENT_LINK_TEST_BIND_IP": value})

    def test_ssh_requires_explicit_account_and_rejects_options(self):
        for value in ["198.51.100.21", "-oProxyCommand=anything", "fixture@host;command", "fixture@host command", "fixture@host\n", "fixture@host:22"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe_settings({**SETTINGS, "AGENT_LINK_TEST_SSH_TARGET": value})

    def test_vmid_is_decimal_not_shell_source(self):
        for value in ["0", "01", "-1", "1;command", "1 --anything", "1.0", "1000000000"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe_settings({**SETTINGS, "AGENT_LINK_TEST_LXC_VMID": value})
            with self.assertRaises(ValueError):
                receiver_command(value, "print('fixture')")

    def test_receiver_identity_settings_are_validated(self):
        for name, value in [
            ("AGENT_LINK_TEST_RECEIVER_HOSTNAME", "host.example.test"),
            ("AGENT_LINK_TEST_RECEIVER_HOSTNAME", "-host"),
            ("AGENT_LINK_TEST_RECEIVER_MARKER", "value\nother"),
            ("AGENT_LINK_TEST_RECEIVER_MARKER", "value;command"),
            ("AGENT_LINK_TEST_RECEIVER_MARKER_FILE", "relative-marker"),
        ]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                probe_settings({**SETTINGS, name: value})

    def test_remote_program_is_one_quoted_argument(self):
        program = "print('fixture'); print(\"quoted value\")"
        command = receiver_command(SETTINGS["AGENT_LINK_TEST_LXC_VMID"], program)
        self.assertEqual(shlex.split(command), ["pct", "exec", "9001", "--", "python3", "-c", program])


if __name__ == "__main__":
    unittest.main()
