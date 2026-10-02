"""Offline preparation and runtime-contract tests; no Docker or database use."""

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("prepare_compose", Path(__file__).with_name("prepare.py"))
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agent-mesh-compose-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cert = self.root / "server.crt"
        self.key = self.root / "server.key"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
            "-nodes", "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", str(self.key), "-out", str(self.cert),
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.key.chmod(0o600)
        self.state = self.root / "state"

    def run_prepare(self, **overrides):
        args = dict(state=str(self.state), image="agent-mesh-ci:revision", cert=str(self.cert), key=str(self.key))
        args.update(overrides)
        return prepare.prepare(**args)

    def test_fresh_state_is_private_nonroot_and_passwords_stay_out_of_env(self):
        self.run_prepare()
        self.assertEqual(set(p.name for p in self.state.iterdir()), {
            "pgdata", "owner", "app-password", "postgres-password", "database-url",
            "server.crt", "server.key", "compose.env",
        })
        for path in (self.state, *self.state.iterdir()):
            self.assertEqual(path.stat().st_uid, os.getuid())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        password = (self.state / "app-password").read_text().strip()
        admin = (self.state / "postgres-password").read_text().strip()
        self.assertRegex(password, r"^[0-9a-f]{64}$")
        self.assertNotEqual(password, admin)
        self.assertEqual((self.state / "database-url").read_text(),
                         f"postgresql://agent_mesh:{password}@db:5432/agent_mesh?sslmode=disable\n")
        env = (self.state / "compose.env").read_text()
        self.assertIn("AGENT_MESH_BIND_IP=127.0.0.1\n", env)
        self.assertIn("AGENT_MESH_PORT=8766\n", env)
        self.assertIn(f"AGENT_MESH_UID={os.getuid()}\n", env)
        for secret in (password, admin, self.key.read_text()):
            self.assertNotIn(secret, env)
        self.assertEqual((self.state / "server.key").read_bytes(), self.key.read_bytes())
        self.assertFalse((self.state / "owner" / "owner.json").exists())
        self.assertEqual(list((self.state / "pgdata").iterdir()), [])

    def test_repeated_prepare_does_not_overwrite_any_state(self):
        self.run_prepare()
        before = {p.name: p.read_bytes() for p in self.state.iterdir() if p.is_file()}
        with self.assertRaises(prepare.PrepareError):
            self.run_prepare()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.state.iterdir() if p.is_file()})

    def test_paths_cannot_escape_or_follow_symlinks(self):
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        for state in ("relative", "/", str(self.root / "absent" / "state"),
                      str(link / "state"), str(prepare.REPO / "state"),
                      str(self.root) + "/./state", str(self.root) + "/../state",
                      str(self.root / "space state"), str(self.root / "$state")):
            with self.subTest(state=state), self.assertRaises(prepare.PrepareError):
                self.run_prepare(state=state)
        self.assertFalse(self.state.exists())

    def test_private_key_permissions_and_symlinks_fail_before_writes(self):
        self.key.chmod(0o644)
        with self.assertRaises(prepare.PrepareError):
            self.run_prepare()
        self.key.chmod(0o600)
        link = self.root / "key-link"
        link.symlink_to(self.key)
        with self.assertRaises(prepare.PrepareError):
            self.run_prepare(key=str(link))
        self.assertFalse(self.state.exists())

    def test_mismatched_tls_fails_before_writes(self):
        other = self.root / "other.key"
        subprocess.run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
                        "-out", str(other)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        other.chmod(0o600)
        with self.assertRaisesRegex(prepare.PrepareError, "do not match"):
            self.run_prepare(key=str(other))
        self.assertFalse(self.state.exists())

    def test_root_or_root_group_is_not_silently_used(self):
        for function in ("getuid", "getgid"):
            with self.subTest(function=function), patch.object(prepare.os, function, return_value=0):
                with self.assertRaises(prepare.PrepareError):
                    self.run_prepare()
        self.assertFalse(self.state.exists())

    def test_unbounded_or_ambiguous_inputs_are_rejected(self):
        bad = ({"image": "agent-mesh"}, {"image": "agent-mesh:latest"},
               {"image": "agent-mesh:ok\nPASSWORD=secret"}, {"image": "agent-mesh:$(id)"},
               {"bind_ip": "localhost"}, {"bind_ip": "127.0.0.1:8766"},
               {"bind_ip": "224.0.0.1"}, {"port": 0}, {"port": 443},
               {"port": 65536}, {"port": True})
        for args in bad:
            with self.subTest(args=args), self.assertRaises(prepare.PrepareError):
                self.run_prepare(**args)
        self.assertFalse(self.state.exists())

    def test_digest_pin_and_explicit_network_choice(self):
        image = "ghcr.io/vlad9572324/agent-mesh@sha256:" + "a" * 64
        self.run_prepare(image=image, bind_ip="192.0.2.1", port=18766)
        env = (self.state / "compose.env").read_text()
        self.assertIn("AGENT_MESH_IMAGE=" + image + "\n", env)
        self.assertIn("AGENT_MESH_BIND_IP=192.0.2.1\n", env)
        self.assertIn("AGENT_MESH_PORT=18766\n", env)


class RuntimeContractTests(unittest.TestCase):
    def test_scratch_image_has_exact_payload_and_no_shell_or_source_copy(self):
        dockerfile = (prepare.REPO / "Dockerfile").read_text()
        self.assertIn("FROM scratch\n", dockerfile)
        self.assertIn("USER 10001:10001\n", dockerfile)
        self.assertIn('CMD ["version"]', dockerfile)
        self.assertIn('ENTRYPOINT ["/opt/agent-mesh/bin/agent-mesh"]', dockerfile)
        copies = [line for line in dockerfile.splitlines() if line.startswith("COPY ")]
        self.assertEqual(len(copies), 3)
        self.assertNotIn("COPY .", dockerfile)
        self.assertNotIn("RUN ", dockerfile)
        self.assertNotIn("ADD ", dockerfile)
        self.assertIn("COPY --chmod=0444 web/index.html web/app.js web/app.css", dockerfile)

    def test_compose_keeps_tls_private_binds_and_bootstrap_explicit(self):
        compose = Path(__file__).with_name("compose.yaml").read_text()
        self.assertIn("profiles: [init]", compose)
        self.assertIn("--tls-cert", compose)
        self.assertIn("--tls-key", compose)
        self.assertIn("--database-url-file", compose)
        self.assertIn("host_ip: ${AGENT_MESH_BIND_IP:-127.0.0.1}", compose)
        self.assertIn("internal: true", compose)
        self.assertEqual(compose.count("ports:"), 1)
        self.assertIn("read_only: true", compose)
        self.assertIn("cap_drop: [ALL]", compose)
        self.assertIn("security_opt: [no-new-privileges:true]", compose)
        self.assertNotIn("POSTGRES_PASSWORD:", compose)
        self.assertNotIn("AGENT_LINK_DATABASE_URL:", compose)
        self.assertNotIn("trust", compose)
        self.assertNotIn("latest", compose)
        self.assertEqual(compose.count("type: bind"), compose.count("create_host_path: false"))

    def test_published_app_has_frontend_but_database_and_bootstrap_stay_internal(self):
        compose = Path(__file__).with_name("compose.yaml").read_text()
        shared, services = compose.split("\nservices:\n", 1)
        database, rest = services.split("\n  app:\n", 1)
        app, rest = rest.split("\n  bootstrap-owner:\n", 1)
        bootstrap, networks = rest.split("\nnetworks:\n", 1)
        self.assertIn("networks: [backend]", shared)
        self.assertIn("networks: [backend]", database)
        self.assertNotIn("frontend", database)
        self.assertIn("networks: [frontend, backend]", app)
        self.assertIn("ports:", app)
        self.assertIn("<<: *app", bootstrap)
        self.assertNotIn("networks:", bootstrap)
        self.assertNotIn("frontend", bootstrap)
        self.assertNotIn("ports:", database + bootstrap)
        self.assertIn("  frontend:\n    driver: bridge\n", networks)
        self.assertIn("  backend:\n    internal: true\n", networks)


if __name__ == "__main__":
    unittest.main()
