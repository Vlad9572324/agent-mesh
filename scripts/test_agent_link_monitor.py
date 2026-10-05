"""Offline tests for the unattended monitor: real TLS fixtures, simulated time, no models."""
import contextlib
import http.server
import importlib.util
import io
import json
import os
import ssl
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import unquote

spec = importlib.util.spec_from_file_location("monitor", Path(__file__).with_name("agent-link-monitor.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

KEY = "k" * 40
WORK = None
CERTS = {}


def openssl(*args):
    subprocess.run(["openssl", *args], check=True, capture_output=True)


def make_cert(name, algorithm="ec", reuse_key=None):
    key, cert = str(WORK / (name + ".key")), str(WORK / (name + ".crt"))
    subject = ["-subj", "/CN=127.0.0.1", "-days", "2", "-addext", "subjectAltName=IP:127.0.0.1"]
    if reuse_key:
        openssl("req", "-x509", "-key", reuse_key, "-out", cert, *subject)
        return reuse_key, cert
    new = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"] if algorithm == "ec" else ["-newkey", "rsa:2048"]
    openssl("req", "-x509", *new, "-nodes", "-keyout", key, "-out", cert, *subject)
    return key, cert


def setUpModule():
    global WORK
    WORK = Path(tempfile.mkdtemp(prefix="monitor-test-"))
    CERTS["ec"] = make_cert("ec")
    CERTS["rsa"] = make_cert("rsa", "rsa")
    CERTS["ec-renewed"] = make_cert("ec2", reuse_key=CERTS["ec"][0])


def pin_of(cert_path):
    pem = Path(cert_path).read_text()
    return monitor.spki_pin(ssl.PEM_cert_to_DER_cert(pem))


class FakeServer:
    """A real HTTPS server on 127.0.0.1 that records what it was sent."""

    def __init__(self, cert, routes=None):
        self.requests, self.routes = [], routes or {}
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization")})
                status, body, ctype, extra = outer.routes.get(self.path.split("?")[0], (404, b'{"error":"nf"}', "application/json", {}))
                if callable(body):
                    body = body()
                extra = dict(extra)
                declared = extra.pop("_content_length", None)
                trickle = extra.pop("_trickle", None)
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(declared if declared is not None else len(body)))
                for k, v in extra.items():
                    self.send_header(k, v)
                self.end_headers()
                if trickle:
                    try:
                        for index in range(len(body)):
                            self.wfile.write(body[index:index + 1])
                            self.wfile.flush()
                            time.sleep(trickle)
                    except OSError:
                        pass
                    return
                self.wfile.write(body)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert[1], cert[0])
        self.httpd.socket = context.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def origin(self):
        return "https://127.0.0.1:%d" % self.port

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class SpkiTests(unittest.TestCase):
    def test_extractor_matches_openssl_for_ec_and_rsa_and_survives_renewal(self):
        for name in ("ec", "rsa"):
            cert = CERTS[name][1]
            expected = subprocess.run("openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64",
                                      shell=True, input=Path(cert).read_bytes(), capture_output=True, check=True).stdout.decode().strip()
            self.assertEqual(pin_of(cert), "sha256//" + expected, name)
        self.assertEqual(pin_of(CERTS["ec"][1]), pin_of(CERTS["ec-renewed"][1]))  # same key, new certificate
        self.assertNotEqual(pin_of(CERTS["ec"][1]), pin_of(CERTS["rsa"][1]))

    def test_truncated_or_hostile_certificates_raise_value_error_not_crash(self):
        der = ssl.PEM_cert_to_DER_cert(Path(CERTS["ec"][1]).read_text())
        for blob in (b"", b"\x30", b"\x30\x80", b"\x30\x84\xff\xff\xff\xff", der[:20], der[:len(der) // 2], b"\x04\x02ab",
                     bytes([0x30, 0x82, 0x01, 0x00]) + b"\x00" * 10, b"\x00" * 100, der + b"x" * 70000):
            with self.assertRaises(ValueError, msg=blob[:8]):
                monitor.spki_der(blob)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.server = FakeServer(CERTS["ec"], {
            "/ok": (200, b'{"agents":[]}', "application/json", {}),
            "/redirect": (302, b"{}", "application/json", {"Location": "https://evil.example/"}),
            "/denied": (401, b'{"error":"no"}', "application/json", {}),
            "/text": (200, b"hello", "text/plain", {}),
            "/broken": (200, b"{not json", "application/json", {}),
            "/nan": (200, b'{"x": NaN}', "application/json", {}),
            "/huge": (200, b" " * (monitor.MAX_RESPONSE_BYTES + 10), "application/json", {}),
            "/slow": (200, lambda: time.sleep(2) or b"{}", "application/json", {}),
        })
        self.addCleanup(self.server.close)
        self.good = pin_of(CERTS["ec"][1])

    def transport(self, pin=None, **options):
        return monitor.Transport(self.server.origin, pin or self.good, timeout=options.pop("timeout", 5), **options)

    def test_pinned_get_sends_the_credential_only_after_the_pin_matches(self):
        status, body = self.transport(verify="pin_only").get_json("/ok", KEY)
        self.assertEqual((status, body), (200, {"agents": []}))
        self.assertEqual(self.server.requests[-1]["auth"], "Bearer " + KEY)

    def test_wrong_pin_is_refused_before_any_request_or_credential_is_sent(self):
        for wrong in (pin_of(CERTS["rsa"][1]), "sha256//" + "A" * 43 + "="):
            with self.assertRaises(monitor.MonitorError) as caught:
                self.transport(pin=wrong, verify="pin_only").get_json("/ok", KEY)
            self.assertEqual(caught.exception.kind, "pin")
        self.assertEqual(self.server.requests, [])  # the server never saw a request, let alone the key

    def test_ca_mode_verifies_chain_and_hostname_and_still_pins(self):
        ok = self.transport(ca_file=CERTS["ec"][1], verify="ca")
        self.assertEqual(ok.get_json("/ok", KEY)[0], 200)
        with self.assertRaises(monitor.MonitorError) as caught:
            self.transport(verify="ca").get_json("/ok", KEY)  # self-signed and no CA given
        self.assertEqual(caught.exception.kind, "tls")
        self.assertEqual(len(self.server.requests), 1)

    def test_renewed_certificate_with_the_same_key_keeps_working(self):
        server = FakeServer(CERTS["ec-renewed"], {"/ok": (200, b"{}", "application/json", {})})
        self.addCleanup(server.close)
        client = monitor.Transport(server.origin, self.good, timeout=5, verify="pin_only")
        self.assertEqual(client.get_json("/ok", KEY)[0], 200)

    def test_redirects_auth_failures_and_hostile_payloads_are_classified_not_followed(self):
        cases = {"/redirect": "http", "/denied": "auth", "/text": "payload", "/broken": "payload", "/nan": "payload", "/huge": "payload"}
        for path, kind in cases.items():
            with self.assertRaises(monitor.MonitorError, msg=path) as caught:
                self.transport(verify="pin_only").get_json(path, KEY)
            self.assertEqual(caught.exception.kind, kind, path)
        self.assertEqual([r["path"] for r in self.server.requests if r["path"] == "/redirect"], ["/redirect"])  # not followed

    def test_slow_server_times_out_and_closed_port_is_a_network_error(self):
        with self.assertRaises(monitor.MonitorError) as caught:
            self.transport(timeout=0.4, verify="pin_only").get_json("/slow", KEY)
        self.assertEqual(caught.exception.kind, "network")
        dead = monitor.Transport("https://127.0.0.1:1", self.good, timeout=1, verify="pin_only")
        with self.assertRaises(monitor.MonitorError) as caught:
            dead.get_json("/ok", KEY)
        self.assertEqual(caught.exception.kind, "network")

    def test_bad_construction_and_paths_are_config_errors(self):
        for origin in ("http://x:1", "https://u:p@x:1", "https://x:1/path", "https://x:1?q=1", "not a url"):
            with self.assertRaises(monitor.MonitorError, msg=origin):
                monitor.Transport(origin, self.good)
        with self.assertRaises(monitor.MonitorError):
            monitor.Transport(self.server.origin, "sha256//short")
        with self.assertRaises(monitor.MonitorError):
            monitor.Transport(self.server.origin, self.good, verify="off")
        with self.assertRaises(monitor.MonitorError):
            self.transport(verify="pin_only").get_json("/ok\r\nX: y", KEY)


# ---------------------------------------------------------------- lifecycle with a scripted API

def agent(identity, state, mode="loop", contact=130, scope="complete", reason="", last="2026-10-05T00:00:00Z"):
    wake = None if mode is None else {"mode": mode, "expected_response_seconds": 60, "expected_contact_seconds": contact,
                                      "version": 1, "updated_at": last, "set_by": "self"}
    return {"id": identity, "kind": "agent", "name": "x", "channel_ids": ["c"], "wake_profile": wake,
            "liveness": {"state": state, "last_contact_at": last, "as_of": last, "source": "message", "scope": scope, "reason": reason}}


def alert(message="m1", recipient="r1", reason="unacknowledged", project="p"):
    return {"message_id": message, "recipient_id": recipient, "project_id": project, "reason": reason}


class ScriptedAPI:
    """Stands in for Transport: returns what the test sets, or raises it."""

    def __init__(self):
        self.agents = {}
        self.agent_status = {}      # project -> HTTP status for its agents read
        self.delivery_pages = [{"alerts": [], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        self.cursor_pages = {}      # decoded cursor -> payload or int status
        self.error = None
        self.delivery_error = None
        self.calls = []

    def get_json(self, path, key=None):
        self.calls.append(path)
        if self.error:
            raise self.error
        if path.startswith("/v1/projects/"):
            project = path.split("/")[3]
            if project in self.agent_status:
                return self.agent_status[project], {"error": "x"}
            return 200, {"agents": self.agents.get(project, [])}
        if path.startswith("/v1/admin/delivery-alerts"):
            if self.delivery_error:
                if isinstance(self.delivery_error, int):
                    return self.delivery_error, {"error": "x"}
                raise self.delivery_error
            if "cursor=" in path:
                cursor = unquote(path.split("cursor=")[1])
                if cursor in self.cursor_pages:
                    value = self.cursor_pages[cursor]
                    value = value.pop(0) if isinstance(value, list) else value
                    return (value, {"error": "x"}) if isinstance(value, int) else (200, value)
                index = int(cursor.split("page")[1])
                return 200, self.delivery_pages[index]
            return 200, self.delivery_pages[0]
        raise AssertionError(path)


class CycleCase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="monitor-state-"))
        os.chmod(self.dir, 0o700)
        self.key_file = self.dir / "key"
        self.key_file.write_text(KEY + "\n")
        os.chmod(self.key_file, 0o600)
        self.config = {"origin": "https://127.0.0.1:1", "pin": "sha256//" + "A" * 43 + "=", "key_file": str(self.key_file),
                       "state_file": str(self.dir / "state.json"), "projects": ["p"], "confirm_observations": 2,
                       "renotify_seconds": 4 * 3600, "api_failures_before_alert": 3, "label": "testhost"}
        self.api = ScriptedAPI()
        self.now = 1_000_000.0
        self.lines = []

    def cycle(self, advance=60.0):
        self.now += advance
        buffer = []
        code = monitor.run_once(self.config, out=buffer.append, now=self.now, transport=self.api)
        self.lines += buffer
        return code, buffer

    def notices(self, buffer):
        return [item for item in buffer if item.startswith("NOTIFY")]


class LifecycleTests(CycleCase):
    def test_silent_promised_agent_notifies_after_confirmation_escalates_repeats_and_resolves_once(self):
        self.api.agents["p"] = [agent("vmora", "silent")]
        self.assertEqual(self.notices(self.cycle()[1]), [])                      # first sighting: confirm first
        second = self.notices(self.cycle()[1])
        self.assertEqual(len(second), 1)
        self.assertIn("open warn agent_contact", second[0])
        self.assertEqual(self.notices(self.cycle()[1]), [])                      # steady state is quiet
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.assertIn("escalate crit", self.notices(self.cycle()[1])[0])
        self.assertEqual(self.notices(self.cycle()[1]), [])
        self.assertIn("reminder", self.notices(self.cycle(advance=4 * 3600)[1])[0])
        self.api.agents["p"] = [agent("vmora", "alive")]
        self.assertEqual(self.notices(self.cycle()[1]), [])                      # one healthy sighting is not recovery
        self.assertIn("resolved", self.notices(self.cycle()[1])[0])
        self.assertEqual(self.notices(self.cycle()[1]), [])

    def test_flapping_below_the_confirmation_threshold_never_notifies(self):
        for state in ("silent", "alive", "silent", "alive", "silent", "alive"):
            self.api.agents["p"] = [agent("vmora", state)]
            self.assertEqual(self.notices(self.cycle()[1]), [], state)

    def test_idle_without_a_promise_and_partial_scope_never_alert(self):
        self.api.agents["p"] = [agent("quiet", "idle", mode=None), agent("loopy", "unknown", reason="partial_visibility", scope="partial")]
        for _ in range(4):
            code, buffer = self.cycle()
            self.assertEqual(self.notices(buffer), [])
        self.assertIn("coverage: partial_visibility:p:loopy", buffer)

    def test_an_agent_we_cannot_conclude_about_keeps_its_incident_instead_of_recovering(self):
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle(); self.cycle()
        self.api.agents["p"] = [agent("vmora", "unknown", reason="reporting_blocked")]
        for _ in range(4):
            self.assertEqual(self.notices(self.cycle()[1]), [])
        state = monitor.StateStore(self.config["state_file"]).load()[0]
        self.assertIn("agent/p/vmora", state["incidents"])

    def test_api_outage_alerts_after_the_threshold_and_holds_other_incidents(self):
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle(); self.cycle()
        self.api.error = monitor.MonitorError("network", "down")
        outcomes = [self.notices(self.cycle()[1]) for _ in range(4)]
        self.assertEqual(outcomes[0], []); self.assertEqual(outcomes[1], [])
        self.assertTrue(any("open crit api" in item for item in outcomes[2]))
        self.assertFalse(any("resolved" in item for batch in outcomes for item in batch))  # nothing recovered while blind
        self.api.error = None
        self.cycle()
        resolved = self.notices(self.cycle()[1])
        self.assertTrue(any("resolved" in item and "api" in item for item in resolved))

    def test_rejected_credential_or_pin_is_reported_immediately_as_config(self):
        for kind in ("auth", "pin", "tls"):
            self.setUp()
            self.api.error = monitor.MonitorError(kind, "rejected")
            code, buffer = self.cycle()
            self.assertEqual(code, 1)
            self.assertTrue(any("open crit config" in item for item in self.notices(buffer)), kind)

    def test_delivery_alerts_paginate_restart_on_cursor_error_and_cap_honestly(self):
        self.api.delivery_pages = [
            {"alerts": [alert("m1", "r1")], "truncated": True, "next_cursor": "page1", "policy": {"enabled": True}},
            {"alerts": [alert("m2", "r2", "unanswered")], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        self.cycle()
        batch = self.notices(self.cycle()[1])
        self.assertEqual(len(batch), 2)
        self.assertTrue(any("crit delivery" in b and "m1" in b for b in batch))
        self.assertTrue(any("warn delivery" in b and "m2" in b for b in batch))
        # More pages than the cap: incomplete scan must not resolve anything and is reported.
        self.api.delivery_pages = [{"alerts": [], "truncated": True, "next_cursor": "page0", "policy": {"enabled": True}}]
        code, buffer = self.cycle()
        self.assertEqual(code, 1)
        self.assertIn("coverage: delivery_scan_incomplete", buffer)
        self.assertFalse(any("resolved" in item for item in self.notices(buffer)))

    def test_agent_keys_cannot_read_delivery_alerts_and_that_is_coverage_not_failure(self):
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.api.delivery_error = monitor.MonitorError("auth", "owner only")
        self.cycle()
        code, buffer = self.cycle()
        self.assertIn("coverage: delivery_alerts_need_owner_key", buffer)
        self.assertEqual(len(self.notices(buffer)), 1)  # the agent incident still works
        self.assertEqual(code, 0)

    def test_disabled_delivery_policy_is_reported_once_as_coverage_never_as_healthy(self):
        self.api.delivery_pages = [{"alerts": [], "truncated": False, "next_cursor": None, "policy": {"enabled": False}}]
        self.cycle()
        first = self.notices(self.cycle()[1])
        self.assertEqual(len(first), 1)
        self.assertIn("info coverage", first[0])
        self.assertEqual(self.notices(self.cycle()[1]), [])

    def test_hostile_identifiers_and_filtered_projects_are_skipped(self):
        self.api.agents["p"] = [agent("evil\nid", "dead"), agent("../x", "dead")]
        self.api.delivery_pages = [{"alerts": [alert("m\nx"), alert("m2", "r2", project="other-project"), {"junk": 1}, "text"],
                                   "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        for _ in range(3):
            self.assertEqual(self.notices(self.cycle()[1]), [])

    def test_state_survives_restart_without_duplicates_and_notifications_are_at_least_once(self):
        hook = self.dir / "hook.sh"
        log = self.dir / "hook.log"
        hook.write_text('#!/bin/sh\nif [ -f "%s" ]; then cat >> "%s"; echo >> "%s"; exit 0; fi\ncat > /dev/null; exit 1\n' % (self.dir / "ok", log, log))
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 5}
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle()
        code, buffer = self.cycle()                       # hook fails: stays pending, run is degraded
        self.assertEqual(code, 1)
        self.assertTrue(any("notify command exited 1" in item for item in buffer))
        (self.dir / "ok").write_text("1")                 # hook recovers; same notification is retried
        code, buffer = self.cycle()
        self.assertEqual(code, 0)
        sent = [json.loads(chunk) for chunk in log.read_text().strip().split("\n") if chunk]
        self.assertEqual(len(sent), 1)
        self.assertEqual((sent[0]["event"], sent[0]["severity"], sent[0]["subject"]), ("open", "crit", "vmora"))
        for _ in range(3):                                # a restart (fresh run) must not repeat it
            self.cycle()
        self.assertEqual(len([c for c in log.read_text().strip().split("\n") if c]), 1)

    def test_hook_is_argv_only_with_json_on_stdin_and_no_secrets_in_its_environment(self):
        hook = self.dir / "hook.sh"
        out = self.dir / "env.out"
        hook.write_text('#!/bin/sh\nenv > "%s"\ncat >> "%s.in"\n' % (out, out))
        os.chmod(hook, 0o755)
        os.environ["MESH_SECRET_TEST"] = "leak-me"
        self.addCleanup(os.environ.pop, "MESH_SECRET_TEST", None)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 5}
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle(); self.cycle()
        environment = out.read_text()
        self.assertNotIn("leak-me", environment)
        self.assertNotIn(KEY, environment)
        payload = json.loads(Path(str(out) + ".in").read_text())
        self.assertNotIn(KEY, json.dumps(payload))
        self.assertEqual(payload["host"], "testhost")

    def test_slow_hook_times_out_and_stays_pending(self):
        hook = self.dir / "slow.sh"
        hook.write_text("#!/bin/sh\nsleep 5\n")
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 1}
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle()
        code, buffer = self.cycle()
        self.assertEqual(code, 1)
        self.assertTrue(any("timed out" in item for item in buffer))
        self.assertEqual(len(monitor.StateStore(self.config["state_file"]).load()[0]["pending"]), 1)

    def test_corrupt_state_is_a_visible_fault_never_an_empty_healthy_baseline(self):
        self.cycle()
        Path(self.config["state_file"]).write_text("{not json")
        code, buffer = self.cycle()
        self.assertEqual(code, 1)
        self.assertTrue(any("state_corrupt" in item for item in buffer))
        self.assertTrue(any("open crit monitor" in item for item in self.notices(buffer)))
        self.assertTrue(list(self.dir.glob("state.json.corrupt-*")))
        for bad in (b"x" * (monitor.MAX_STATE_BYTES + 10), json.dumps({"version": 99, "incidents": {}, "pending": []}).encode(), b"[]"):
            Path(self.config["state_file"]).write_bytes(bad)
            self.assertEqual(self.cycle()[0], 1)

    def test_only_one_run_may_hold_the_state_lock_and_state_files_are_private(self):
        first = monitor.StateStore(self.config["state_file"])
        first.lock()
        self.addCleanup(first.unlock)
        with self.assertRaises(monitor.MonitorError) as caught:
            monitor.run_once(self.config, out=lambda _: None, now=self.now, transport=self.api)
        self.assertEqual(caught.exception.kind, "busy")
        first.unlock()
        self.cycle()
        mode = stat.S_IMODE(os.stat(self.config["state_file"]).st_mode)
        self.assertEqual(mode, 0o600)

    def test_clock_rollback_rebaselines_reminders_instead_of_spamming(self):
        self.api.agents["p"] = [agent("vmora", "dead")]
        self.cycle(); self.cycle()
        self.now -= 10 * 3600  # the wall clock jumps back ten hours
        self.assertEqual(self.notices(self.cycle(advance=0)[1]), [])
        self.assertEqual(self.notices(self.cycle()[1]), [])

    def test_notification_ids_are_unique_and_stable_per_incident(self):
        self.api.agents["p"] = [agent("a", "dead"), agent("b", "dead")]
        self.cycle(); self.cycle()
        state = monitor.StateStore(self.config["state_file"]).load()[0]
        ids = [n["id"] for n in state["pending"]] or []
        self.assertEqual(len(set(ids)), len(ids))

    def test_heartbeat_fires_only_after_a_complete_successful_cycle(self):
        beats = []
        original = monitor.heartbeat
        monitor.heartbeat = lambda path: beats.append(path)
        self.addCleanup(setattr, monitor, "heartbeat", original)
        self.config["heartbeat_url_file"] = str(self.dir / "hb")
        self.cycle()
        self.assertEqual(len(beats), 1)
        self.api.error = monitor.MonitorError("network", "down")
        self.cycle()
        self.assertEqual(len(beats), 1)                  # blind cycle: no "I am healthy" ping
        self.api.error = None
        self.api.delivery_pages = [{"alerts": [], "truncated": True, "next_cursor": "page0", "policy": {"enabled": True}}]
        self.cycle()
        self.assertEqual(len(beats), 1)                  # partial scan: no ping either

    def test_status_view_is_read_only_and_reports_what_the_server_concludes(self):
        self.api.agents["p"] = [agent("vmora", "dead"), agent("quiet", "idle", mode=None)]
        lines = []
        self.assertEqual(monitor.status(self.config, out=lines.append, transport=self.api), 0)
        self.assertTrue(any("vmora" in item and "dead" in item and "promise=yes" in item for item in lines))
        self.assertTrue(any("quiet" in item and "promise=no" in item for item in lines))
        self.assertFalse(Path(self.config["state_file"]).exists())


class HardeningTests(CycleCase):
    """One test per defect found in review: blind reads, lost notifications, volume, identities, framing."""

    def dead(self, *ids):
        return [agent(i, "dead") for i in ids]

    def test_server_errors_on_required_reads_are_degraded_never_healthy_and_never_heartbeat(self):
        beats = []
        original = monitor.heartbeat
        monitor.heartbeat = lambda path: beats.append(path)
        self.addCleanup(setattr, monitor, "heartbeat", original)
        self.config["heartbeat_url_file"] = str(self.dir / "hb")
        self.api.error = monitor.MonitorError("network", "down")
        for _ in range(3):
            self.cycle()
        self.api.error = None
        self.api.agent_status["p"] = 500                      # reachable, but the required read fails
        for _ in range(4):
            code, buffer = self.cycle()
            self.assertEqual(code, 1)
            self.assertFalse(any("resolved" in item for item in self.notices(buffer)))
        self.assertEqual(beats, [])
        del self.api.agent_status["p"]
        self.cycle()
        self.assertTrue(any("resolved" in item for item in self.notices(self.cycle()[1])))
        self.assertEqual(len(beats), 2)

    def test_only_an_explicit_alive_observation_resolves_blind_variants_hold(self):
        self.api.agents["p"] = self.dead("vmora")
        self.cycle(); self.cycle()
        blind = [[], [agent("vmora", "unknown", reason="no_contact")], [{"id": "vmora", "kind": "agent", "name": "x"}],
                 [agent("vmora", "idle", mode=None)], [agent("vmora", "unknown", reason="partial_visibility", scope="partial")]]
        for rows in blind:
            self.api.agents["p"] = rows
            for _ in range(3):
                self.assertEqual(self.notices(self.cycle()[1]), [], rows)
        self.api.agents["p"] = [agent("vmora", "alive")]
        self.assertEqual(self.notices(self.cycle()[1]), [])
        self.assertIn("resolved", self.notices(self.cycle()[1])[0])

    def test_disabling_delivery_monitoring_never_reads_as_delivery_recovery(self):
        self.api.delivery_pages = [{"alerts": [alert("m1", "r1")], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        self.cycle(); self.cycle()
        self.api.delivery_pages = [{"alerts": [], "truncated": False, "next_cursor": None, "policy": {"enabled": False}}]
        for _ in range(4):
            self.assertFalse(any("resolved" in item for item in self.notices(self.cycle()[1])))
        self.api.delivery_pages = [{"alerts": [], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        self.cycle()
        self.assertTrue(any("resolved" in item and "delivery" in item for item in self.notices(self.cycle()[1])))

    def test_the_outbox_is_on_disk_before_any_hook_runs_and_survives_a_crash(self):
        self.api.agents["p"] = self.dead("vmora")
        self.cycle()
        original = monitor.deliver

        def crash(*_args, **_kwargs):
            raise RuntimeError("killed during delivery")
        monitor.deliver = crash
        self.addCleanup(setattr, monitor, "deliver", original)
        self.now += 60
        with self.assertRaises(RuntimeError):
            monitor.run_once(self.config, out=lambda _: None, now=self.now, transport=self.api)
        pending = monitor.StateStore(self.config["state_file"]).load()[0]["pending"]
        self.assertEqual([item["event"] for item in pending], ["open"])
        monitor.deliver = original
        notices = self.notices(self.cycle()[1])
        self.assertEqual(len(notices), 1)                   # delivered on the next run, once
        self.assertIn("open crit agent_contact", notices[0])

    def test_backpressure_never_drops_a_notification_and_reports_the_overflow_once(self):
        original = monitor.MAX_PENDING
        monitor.MAX_PENDING = 5
        self.addCleanup(setattr, monitor, "MAX_PENDING", original)
        hook = self.dir / "hook.sh"
        sink = self.dir / "sink"
        hook.write_text('#!/bin/sh\nif [ -f "%s" ]; then cat >> "%s"; echo >> "%s"; exit 0; fi\ncat > /dev/null; exit 1\n' % (self.dir / "ok", sink, sink))
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 5}
        ids = ["a%02d" % i for i in range(12)]
        self.api.agents["p"] = self.dead(*ids)
        for _ in range(3):
            self.cycle()                                    # hook failing: queue fills, nothing is lost
        state = monitor.StateStore(self.config["state_file"]).load()[0]
        self.assertLessEqual(len(state["pending"]), 5 + 1)
        (self.dir / "ok").write_text("1")                   # hook recovers: backlog drains over the next runs
        for _ in range(8):
            self.cycle()
        sent = [json.loads(c) for c in sink.read_text().strip().split("\n") if c]
        opened = sorted(n["subject"] for n in sent if n["event"] == "open" and n["kind"] == "agent_contact")
        self.assertEqual(opened, ids)                      # every incident reported exactly once
        self.assertEqual(len([n for n in sent if n["event"] == "overflow"]), 1)

    def test_a_thousand_alerts_with_maximum_length_ids_still_persist_and_progress(self):
        long_id = lambda prefix, i: (prefix + str(i)).ljust(120, "x")
        self.api.delivery_pages = [{"alerts": [alert(long_id("m", i), long_id("r", i), project="p") for i in range(1000)],
                                    "truncated": False, "next_cursor": None, "policy": {"enabled": True}}]
        for _ in range(3):
            self.assertEqual(self.cycle()[0], 0)
        size = os.path.getsize(self.config["state_file"])
        self.assertLess(size, monitor.MAX_STATE_BYTES)
        state, fault = monitor.StateStore(self.config["state_file"]).load()
        self.assertIsNone(fault)
        self.assertEqual(len(state["incidents"]), 1000)

    def test_incident_identities_cannot_collide_and_holds_are_per_project_and_agent(self):
        self.config["projects"] = ["p", "p:a"]
        self.api.agents = {"p": self.dead("a:b"), "p:a": self.dead("b")}
        self.cycle()
        opened = self.notices(self.cycle()[1])
        self.assertEqual(len(opened), 2)                    # ("p","a:b") and ("p:a","b") stay distinct
        self.config["projects"] = ["p", "q"]
        self.api.agents = {"p": self.dead("x"), "q": self.dead("x")}
        self.cycle(); self.cycle()
        self.api.agents = {"p": [agent("x", "alive")], "q": [agent("x", "unknown", reason="no_contact")]}
        self.cycle()
        resolved = self.notices(self.cycle()[1])
        self.assertEqual(len([r for r in resolved if "resolved" in r and "agent x" in r]), 1)  # only p's x recovered
        state = monitor.StateStore(self.config["state_file"]).load()[0]
        self.assertIn("agent/q/x", state["incidents"])
        self.assertNotIn("agent/p/x", state["incidents"])

    def test_one_projects_failure_does_not_erase_what_another_project_proved(self):
        self.config["projects"] = ["p", "q"]
        self.api.agents = {"p": self.dead("vmora"), "q": self.dead("other")}
        self.cycle(); self.cycle()
        self.api.agent_status["q"] = 500
        self.api.agents["p"] = [agent("vmora", "alive")]
        self.cycle()
        resolved = self.notices(self.cycle()[1])
        self.assertTrue(any("resolved" in r and "vmora" in r for r in resolved))   # p progressed
        self.assertFalse(any("other" in r for r in resolved))                      # q is held
        state = monitor.StateStore(self.config["state_file"]).load()[0]
        self.assertIn("agent/q/other", state["incidents"])

    def test_structurally_corrupt_state_is_a_fault_not_an_exception(self):
        self.cycle()
        base = {"version": 1, "incidents": {}, "pending": [], "api_failures": 0, "last_run_wall": 0.0, "seq": 0, "dropped": 0}
        bad = [{**base, "incidents": {"agent/p/a": None}}, {**base, "pending": [{}]}, {**base, "incidents": {"k": {"k": "agent_contact"}}},
               {**base, "api_failures": -1}, {**base, "last_run_wall": "x"}, {**base, "seq": True and "1"}]
        for state in bad:
            Path(self.config["state_file"]).write_text(json.dumps(state))
            code, buffer = self.cycle()
            self.assertEqual(code, 1)
            self.assertTrue(any("open crit monitor" in item for item in self.notices(buffer)), state)
        Path(self.config["state_file"]).write_text('{"version":1,"incidents":{},"pending":[],"api_failures":0,"last_run_wall":NaN,"seq":0,"dropped":0}')
        self.assertEqual(self.cycle()[0], 1)

    def test_a_truncated_scan_without_a_usable_cursor_is_incomplete_not_complete(self):
        self.cycle(); self.cycle()
        for cursor in (None, "", "has space", "caf\u00e9", "x" * 3000):
            self.api.delivery_pages = [{"alerts": [alert("m1", "r1")], "truncated": True, "next_cursor": cursor, "policy": {"enabled": True}}]
            code, buffer = self.cycle()
            self.assertEqual(code, 1, repr(cursor))
            self.assertIn("coverage: delivery_scan_incomplete", buffer)

    def test_cursors_are_url_encoded_and_a_conflict_restarts_the_traversal_once(self):
        first = {"alerts": [alert("m1", "r1")], "truncated": True, "next_cursor": "x&limit=1", "policy": {"enabled": True}}
        second = {"alerts": [alert("m2", "r2")], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}
        self.api.delivery_pages = [first]
        self.api.cursor_pages = {"x&limit=1": [409, second]}   # first follow-up conflicts, then succeeds after a restart
        code, buffer = self.cycle()
        self.assertEqual(code, 0)
        delivery_calls = [c for c in self.api.calls if c.startswith("/v1/admin/delivery-alerts")]
        self.assertTrue(any("cursor=x%26limit%3D1" in c for c in delivery_calls))     # encoded, no parameter injection
        self.assertEqual(len([c for c in delivery_calls if "cursor=" not in c]), 2)   # the traversal restarted once
        self.api.cursor_pages = {"x&limit=1": 409}
        self.api.calls.clear()
        self.assertEqual(self.cycle()[0], 1)                                           # persistent conflict: degraded, bounded
        self.assertLessEqual(len([c for c in self.api.calls if c.startswith("/v1/admin/delivery-alerts")]), 4)

    def test_unreadable_key_reaches_the_hook_as_a_config_incident(self):
        hook = self.dir / "hook.sh"
        sink = self.dir / "sink"
        hook.write_text('#!/bin/sh\ncat >> "%s"\n' % sink)
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 5}
        os.chmod(self.key_file, 0o644)                       # unsafe permissions: the monitor refuses to use it
        code, buffer = self.cycle()
        self.assertEqual(code, 1)
        self.assertTrue(any("open crit config" in item for item in self.notices(buffer)))
        self.assertIn('"kind": "config"', sink.read_text())
        self.assertNotIn(KEY, sink.read_text())

    def test_pending_ids_are_unique_while_the_queue_is_still_full(self):
        hook = self.dir / "fail.sh"
        hook.write_text("#!/bin/sh\ncat > /dev/null\nexit 1\n")
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 5}
        self.api.agents["p"] = self.dead("a", "b", "c")
        self.cycle(); self.cycle()
        pending = monitor.StateStore(self.config["state_file"]).load()[0]["pending"]
        ids = [n["id"] for n in pending]
        self.assertEqual(len(ids), 3)
        self.assertEqual(len(set(ids)), 3)

    def test_a_noisy_hook_cannot_exhaust_memory_and_does_not_slow_the_cycle(self):
        hook = self.dir / "noisy.sh"
        hook.write_text("#!/bin/sh\ncat > /dev/null\nhead -c 20000000 /dev/zero | tr '\\0' 'x'\n")
        os.chmod(hook, 0o755)
        self.config["notify"] = {"command": [str(hook)], "timeout_seconds": 20}
        self.api.agents["p"] = self.dead("vmora")
        self.cycle()
        started = time.monotonic()
        code, _ = self.cycle()
        self.assertEqual(code, 0)
        self.assertLess(time.monotonic() - started, 10)

    def test_a_state_directory_others_can_write_is_refused(self):
        os.chmod(self.dir, 0o777)
        self.addCleanup(os.chmod, self.dir, 0o700)
        with self.assertRaises(monitor.MonitorError) as caught:
            monitor.run_once(self.config, out=lambda _: None, now=self.now, transport=self.api)
        self.assertEqual(caught.exception.kind, "config")


class FramingTests(unittest.TestCase):
    def transport(self, server):
        return monitor.Transport(server.origin, pin_of(CERTS["ec"][1]), timeout=2, verify="pin_only")

    def test_a_response_shorter_than_its_declared_length_is_rejected(self):
        server = FakeServer(CERTS["ec"], {"/short": (200, b'{"a":1}', "application/json", {"_content_length": "100"})})
        self.addCleanup(server.close)
        with self.assertRaises(monitor.MonitorError) as caught:
            self.transport(server).get_json("/short", KEY)
        self.assertIn(caught.exception.kind, ("payload", "network"))

    def test_a_trickling_server_cannot_hold_the_monitor_past_the_overall_deadline(self):
        server = FakeServer(CERTS["ec"], {"/slow": (200, b'{"padding": "' + b"x" * 40 + b'"}', "application/json", {"_trickle": 0.2})})
        self.addCleanup(server.close)
        original = monitor.READ_DEADLINE_SECONDS
        monitor.READ_DEADLINE_SECONDS = 1.0
        self.addCleanup(setattr, monitor, "READ_DEADLINE_SECONDS", original)
        started = time.monotonic()
        with self.assertRaises(monitor.MonitorError) as caught:
            self.transport(server).get_json("/slow", KEY)
        self.assertEqual(caught.exception.kind, "network")
        self.assertLess(time.monotonic() - started, 4)

    def test_deeply_nested_json_is_a_payload_error_not_a_crash(self):
        server = FakeServer(CERTS["ec"], {"/deep": (200, b"[" * 100000 + b"]" * 100000, "application/json", {})})
        self.addCleanup(server.close)
        with self.assertRaises(monitor.MonitorError) as caught:
            self.transport(server).get_json("/deep", KEY)
        self.assertEqual(caught.exception.kind, "payload")


class DerBoundaryTests(unittest.TestCase):
    def test_child_lengths_must_stay_inside_their_container_and_consume_it_exactly(self):
        der = bytearray(ssl.PEM_cert_to_DER_cert(Path(CERTS["ec"][1]).read_text()))
        _tag, header, _length = monitor._der(bytes(der), 0)
        _t, tbs_header, _l = monitor._der(bytes(der), header)
        serial = header + tbs_header + 5                      # after the 5-byte explicit [0] version
        self.assertEqual(der[serial], 0x02)
        for delta in (1, 50, -1):
            patched = bytearray(der)
            patched[serial + 1] = (patched[serial + 1] + delta) % 256
            with self.assertRaises(ValueError, msg=delta):
                monitor.spki_der(bytes(patched))
        trailing = bytes(der) + b"\x00"
        with self.assertRaises(ValueError):
            monitor.spki_der(trailing)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="monitor-config-"))
        os.chmod(self.dir, 0o700)

    def write(self, data, mode=0o600, name="config.json"):
        path = self.dir / name
        path.write_text(json.dumps(data) if not isinstance(data, str) else data)
        os.chmod(path, mode)
        return str(path)

    def good(self, **changes):
        base = {"origin": "https://h:1", "pin": "sha256//" + "A" * 43 + "=", "key_file": str(self.dir / "k"),
                "state_file": str(self.dir / "s.json"), "projects": ["p"]}
        return {**base, **changes}

    def test_valid_config_loads_and_bad_ones_are_rejected_with_a_config_error(self):
        monitor.load_config(self.write(self.good()))
        bad = [self.good(projects=[]), self.good(projects=["a b"]), self.good(key_file="relative"), self.good(state_file="s.json"),
               self.good(notify={"command": ["relative-hook"]}), self.good(notify={"command": "sh -c x"}),
               self.good(notify={"command": []}), self.good(confirm_observations=0), self.good(renotify_seconds=1),
               self.good(api_failures_before_alert=1000), {"origin": "https://h:1"}, [], "not json"]
        for item in bad:
            with self.assertRaises(monitor.MonitorError, msg=str(item)[:60]) as caught:
                monitor.load_config(self.write(item))
            self.assertEqual(caught.exception.kind, "config")

    def test_secret_files_must_be_private_regular_and_not_symlinks(self):
        secret = self.write(KEY, mode=0o600, name="key")
        self.assertEqual(monitor.read_key(secret), KEY)
        for mode in (0o644, 0o640, 0o604, 0o666):
            os.chmod(secret, mode)
            with self.assertRaises(monitor.MonitorError, msg=oct(mode)):
                monitor.read_key(secret)
        os.chmod(secret, 0o600)
        link = self.dir / "link"
        link.symlink_to(secret)
        with self.assertRaises(monitor.MonitorError):
            monitor.read_key(str(link))
        with self.assertRaises(monitor.MonitorError):
            monitor.read_key(str(self.dir / "missing"))
        short = self.write("short", name="short")
        with self.assertRaises(monitor.MonitorError):
            monitor.read_key(short)


    def test_notify_and_verify_shapes_are_validated(self):
        for item in (self.good(notify="hook"), self.good(notify=[]), self.good(notify={"timeout_seconds": None}),
                     self.good(notify={"timeout_seconds": 0}), self.good(notify={"timeout_seconds": 9999}),
                     self.good(notify={"timeout_seconds": True}), self.good(verify="off"), self.good(projects=["p"] * 51)):
            with self.assertRaises(monitor.MonitorError, msg=str(item)[:70]):
                monitor.load_config(self.write(item))

    def test_a_fifo_where_a_key_should_be_cannot_hang_the_monitor(self):
        fifo = self.dir / "fifo"
        os.mkfifo(fifo, 0o600)
        started = time.monotonic()
        with self.assertRaises(monitor.MonitorError):
            monitor.read_key(str(fifo))
        self.assertLess(time.monotonic() - started, 2)

    def test_a_bad_ca_file_or_port_is_a_config_error(self):
        pin = pin_of(CERTS["ec"][1])
        with self.assertRaises(monitor.MonitorError) as caught:
            monitor.Transport("https://127.0.0.1:1", pin, ca_file="/nonexistent/ca.pem", verify="ca")
        self.assertEqual(caught.exception.kind, "config")
        for origin in ("https://127.0.0.1:99999", "https://127.0.0.1:0"):
            with self.assertRaises(monitor.MonitorError):
                monitor.Transport(origin, pin)

    def test_errors_never_contain_the_key(self):
        secret = self.write(KEY + "\n", name="key")
        try:
            monitor.read_key(self.write("x" * 3, name="bad"))
        except monitor.MonitorError as error:
            self.assertNotIn(KEY, str(error))
        self.assertEqual(monitor.read_key(secret), KEY)


class EntryPointTests(unittest.TestCase):
    def test_show_pin_prints_the_server_pin_without_sending_a_credential(self):
        server = FakeServer(CERTS["ec"])
        self.addCleanup(server.close)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.assertEqual(monitor.main(["--show-pin", server.origin]), 0)
        self.assertEqual(buffer.getvalue().strip(), pin_of(CERTS["ec"][1]))
        self.assertEqual(server.requests, [])

    def test_missing_or_relative_config_is_a_usage_error_and_config_errors_exit_two(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            monitor.main([])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            monitor.main(["--config", "relative.json"])
        with contextlib.redirect_stderr(io.StringIO()) as captured:
            self.assertEqual(monitor.main(["--config", "/nonexistent/config.json"]), 2)
        self.assertNotIn(KEY, captured.getvalue())

    def test_end_to_end_against_a_real_tls_server_notifies_and_never_leaks_the_key(self):
        server = FakeServer(CERTS["ec"], {
            "/v1/projects/p/agents": (200, json.dumps({"agents": [agent("vmora", "dead")]}).encode(), "application/json", {}),
            "/v1/admin/delivery-alerts": (200, json.dumps({"alerts": [], "truncated": False, "next_cursor": None, "policy": {"enabled": True}}).encode(), "application/json", {})})
        self.addCleanup(server.close)
        directory = Path(tempfile.mkdtemp(prefix="monitor-e2e-"))
        os.chmod(directory, 0o700)
        key = directory / "key"
        key.write_text(KEY)
        os.chmod(key, 0o600)
        config = {"origin": server.origin, "pin": pin_of(CERTS["ec"][1]), "verify": "pin_only", "key_file": str(key),
                  "state_file": str(directory / "state.json"), "projects": ["p"], "confirm_observations": 2}
        path = directory / "config.json"
        path.write_text(json.dumps(config))
        os.chmod(path, 0o600)
        outputs = []
        for _ in range(2):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(monitor.main(["--config", str(path)]), 0)
            outputs.append(buffer.getvalue())
        self.assertEqual(outputs[0], "")
        self.assertIn("NOTIFY open crit agent_contact", outputs[1])
        self.assertNotIn(KEY, "".join(outputs))
        self.assertTrue(all(r["auth"] == "Bearer " + KEY for r in server.requests))
        self.assertTrue({"/v1/projects/p/agents", "/v1/admin/delivery-alerts"} <= {r["path"].split("?")[0] for r in server.requests})


if __name__ == "__main__":
    unittest.main()
