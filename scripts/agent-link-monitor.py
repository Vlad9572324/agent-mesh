#!/usr/bin/env python3
"""Unattended, model-free watcher for Agent Mesh.

The server never wakes models and computes alerts only when someone asks, so a stalled
agent or an unread message can sit unnoticed. This one-shot script (run it from cron or a
systemd timer every minute) reads the server's own conclusions over a pinned TLS channel
and tells a human through an operator-configured command. It starts no model, presses no
keys, acknowledges nothing, and writes nothing to the server.

What it reports (never re-deriving the server's classification):
  * agent_contact   an agent that PROMISED a contact cadence is silent/dead (complete scope only)
  * delivery        a message past its acknowledgement/reply deadline (owner key + enabled policy)
  * api / config    the server cannot be reached, or the key/pin/TLS is rejected
  * coverage        what it cannot see (partial visibility, delivery monitoring disabled)
It confirms before notifying, escalates, repeats rarely, and announces recovery only after
the same conditions have been observed healthy again. After a failed or partial read it keeps
existing incidents instead of calling them recovered.

Credential: any existing key works. An OWNER key sees every channel and the delivery alerts
but carries administration authority; an agent key is least privilege but sees only shared
channels, so it can report `alive` but cannot conclude silent/dead for agents it only partly
sees. Use a file readable only by the monitor's user.
"""

import argparse
import base64
import fcntl
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from urllib.parse import quote, urlsplit

VERSION = 1
MAX_RESPONSE_BYTES = 1 << 20
MAX_STATE_BYTES = 8 << 20
MAX_PAGES = 20
MAX_ALERT_ROWS = 1000
MAX_PENDING = 200
MAX_INCIDENTS = 1500
READ_DEADLINE_SECONDS = 30.0
STATE_TEXT = re.compile(r"[A-Za-z0-9_./:-]{0,260}\Z")
CURSOR = re.compile(r"[\x21-\x7e]{1,2048}\Z")
HOOK_OUTPUT_LIMIT = 4096
IDENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
KEY_TEXT = re.compile(r"[A-Za-z0-9_.+/=-]{16,512}\Z")
SEVERITY_RANK = {"info": 0, "warn": 1, "crit": 2}


class MonitorError(Exception):
    """kind is a short enum used for reporting; the message never contains secrets."""

    def __init__(self, kind, message=""):
        super().__init__(message or kind)
        self.kind = kind


# ---------------------------------------------------------------- TLS pinning (stdlib only)

def _der(buf, offset):
    """Return (tag, header_length, content_length) of the DER element at offset; bounded, definite length only."""
    if offset + 2 > len(buf):
        raise ValueError("truncated DER")
    tag, first = buf[offset], buf[offset + 1]
    if first < 0x80:
        return tag, 2, first
    count = first & 0x7F
    if count == 0 or count > 3 or offset + 2 + count > len(buf):
        raise ValueError("unsupported DER length")
    return tag, 2 + count, int.from_bytes(buf[offset + 2:offset + 2 + count], "big")


def _children(buf, start, end):
    """The direct children of a DER container as (tag, offset, total_length); exact, in-bounds consumption."""
    out, cursor = [], start
    while cursor < end:
        tag, header, length = _der(buf, cursor)
        if cursor + header + length > end:
            raise ValueError("child overruns its container")
        out.append((tag, cursor, header + length))
        cursor += header + length
    if cursor != end:
        raise ValueError("container not exactly consumed")
    return out


def spki_der(certificate):
    """Extract the SubjectPublicKeyInfo element of a DER X.509 certificate (bounded, strict)."""
    if len(certificate) > 64 * 1024:
        raise ValueError("certificate too large")
    tag, header, length = _der(certificate, 0)
    if tag != 0x30 or header + length != len(certificate):
        raise ValueError("not a certificate")
    top = _children(certificate, header, header + length)
    if len(top) != 3 or top[0][0] != 0x30:
        raise ValueError("no tbsCertificate")
    _t, tbs_start, tbs_total = top[0]
    _tag, tbs_header, tbs_length = _der(certificate, tbs_start)
    elements = _children(certificate, tbs_start + tbs_header, tbs_start + tbs_header + tbs_length)
    if elements and elements[0][0] == 0xA0:  # explicit [0] version
        elements = elements[1:]
    # serialNumber INTEGER, signature, issuer, validity, subject, subjectPublicKeyInfo
    if len(elements) < 6 or [e[0] for e in elements[:6]] != [0x02, 0x30, 0x30, 0x30, 0x30, 0x30]:
        raise ValueError("no subjectPublicKeyInfo")
    _tag, start, size = elements[5]
    _t2, h2, l2 = _der(certificate, start)
    inner = _children(certificate, start + h2, start + h2 + l2)
    if len(inner) != 2 or [i[0] for i in inner] != [0x30, 0x03]:
        raise ValueError("malformed subjectPublicKeyInfo")
    return certificate[start:start + size]


def spki_pin(certificate):
    return "sha256//" + base64.b64encode(hashlib.sha256(spki_der(certificate)).digest()).decode("ascii")


def valid_pin(pin):
    try:
        return type(pin) is str and pin.startswith("sha256//") and len(base64.b64decode(pin[8:], validate=True)) == 32
    except ValueError:
        return False


def _kill(sock):
    """Watchdog: force a stuck socket closed so an overall deadline holds in every phase.
    The socket object is captured up front: http.client drops `connection.sock` once a response is open."""
    if sock is None:
        return
    for action in (lambda: sock.shutdown(socket.SHUT_RDWR), sock.close):
        try:
            action()
        except OSError:
            pass


class Transport:
    """GET-only JSON client. The server key is checked against the pin on the same connection
    BEFORE the Authorization header is sent; redirects and proxies are never used."""

    def __init__(self, origin, pin, ca_file=None, timeout=10.0, verify="ca"):
        parts = urlsplit(origin)
        try:
            port = parts.port
        except ValueError as error:
            raise MonitorError("config", "origin has an invalid port") from error
        if (parts.scheme != "https" or not parts.hostname or parts.username or parts.password or port == 0
                or parts.path not in ("", "/") or parts.query or parts.fragment):
            raise MonitorError("config", "origin must be a bare https origin")
        if not valid_pin(pin):
            raise MonitorError("config", "pin must be sha256//<base64 of 32 bytes>")
        self.host, self.port, self.pin, self.timeout = parts.hostname, port or 443, pin, timeout
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        if verify == "ca":
            context.verify_mode = ssl.CERT_REQUIRED
            context.check_hostname = True
            try:
                if ca_file:
                    context.load_verify_locations(cafile=ca_file)
                else:
                    context.load_default_certs()
            except (OSError, ssl.SSLError) as error:
                raise MonitorError("config", "cannot load the CA file") from error
        elif verify == "pin_only":
            # Deliberate and explicit: the chain is not verified, but the server's exact public key
            # is pinned and compared before the Authorization header is ever sent, so an
            # interceptor without that private key cannot obtain the credential.
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        else:
            raise MonitorError("config", "verify must be 'ca' or 'pin_only'")
        self.context = context

    def _connect(self):
        connection = http.client.HTTPSConnection(self.host, self.port, timeout=self.timeout, context=self.context)
        try:
            connection.connect()
            certificate = connection.sock.getpeercert(binary_form=True)
        except ssl.SSLCertVerificationError as error:
            connection.close()
            raise MonitorError("tls", "certificate verification failed") from error
        except (OSError, ssl.SSLError, http.client.HTTPException) as error:
            connection.close()
            raise MonitorError("network", type(error).__name__) from error
        try:
            observed = spki_pin(certificate)
        except ValueError as error:
            connection.close()
            raise MonitorError("pin", "unreadable server certificate") from error
        if not hmac.compare_digest(observed, self.pin):
            connection.close()
            raise MonitorError("pin", "server key does not match the pin")
        return connection

    def get_json(self, path, key=None):
        if not path.startswith("/") or any(c in path for c in "\r\n "):
            raise MonitorError("config", "bad request path")
        connection = self._connect()
        expired, raw = threading.Event(), connection.sock

        def fire():
            expired.set()
            _kill(raw)
        watchdog = threading.Timer(READ_DEADLINE_SECONDS, fire)
        watchdog.daemon = True
        watchdog.start()
        try:
            headers = {"Accept": "application/json", "Connection": "close", "User-Agent": "agent-link-monitor/%d" % VERSION}
            if key is not None:
                headers["Authorization"] = "Bearer " + key
            chunks, total = [], 0
            try:
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise MonitorError("payload", "response too large")
                    chunks.append(chunk)
            except MonitorError:
                raise
            except (OSError, http.client.HTTPException) as error:
                raise MonitorError("network", type(error).__name__) from error
            if expired.is_set():
                raise MonitorError("network", "read deadline exceeded")
            body = b"".join(chunks)
            declared = response.getheader("Content-Length")
            if declared is not None and (not declared.isdigit() or int(declared) != len(body)):
                raise MonitorError("payload", "incomplete response body")
            status = response.status
            if status in (301, 302, 303, 307, 308):
                raise MonitorError("http", "redirect refused")
            if status in (401, 403):
                raise MonitorError("auth", "credential rejected (%d)" % status)
            if not response.getheader("Content-Type", "").lower().startswith("application/json"):
                raise MonitorError("payload", "not JSON (status %d)" % status)
            try:
                value = json.loads(body.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError, RecursionError) as error:
                raise MonitorError("payload", "malformed JSON") from error
            return status, value
        finally:
            watchdog.cancel()
            connection.close()


# ---------------------------------------------------------------- observation

CONFIG_KINDS = frozenset({"auth", "pin", "tls", "config"})
KINDS = frozenset({"agent_contact", "delivery", "api", "config", "coverage"})
EVENTS = frozenset({"open", "escalate", "reminder", "resolved", "test", "overflow"})
LIVE_STATES = frozenset({"unknown", "alive", "idle", "silent", "dead"})


def ident(value):
    return type(value) is str and IDENT.match(value) is not None


def parse_time(value):
    if type(value) is not str:
        return None
    match = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})\Z", value)
    if not match:
        return None
    fraction = ((match.group(2) or "0") + "000000")[:6]
    zone = "+00:00" if match.group(3) == "Z" else match.group(3)
    try:
        return datetime.fromisoformat("%s.%s%s" % (match.group(1), fraction, zone)).timestamp()
    except ValueError:
        return None


def describe(kind, severity, subject, ref):
    """Notification text is built only from validated tokens and fixed phrases, never server free text."""
    if kind == "agent_contact":
        return "agent %s is %s: promised contact cadence missed" % (subject, "dead" if severity == "crit" else "silent")
    if kind == "delivery":
        return "message %s to %s is %s past its deadline" % (ref, subject, "unacknowledged" if severity == "crit" else "unanswered")
    if kind == "api":
        return "cannot read the Agent Mesh server completely"
    if kind == "config":
        return "the credential, pin, TLS or monitor configuration was rejected (%s)" % subject
    if kind == "coverage":
        return "delivery deadline monitoring is disabled on the server, so unread messages are not watched"
    if kind == "test":
        return "test notification from agent-link-monitor"
    return str(subject)


def incident(key, kind, severity, subject, project=None, ref=None):
    return {"key": key, "kind": kind, "severity": severity, "subject": subject, "project": project, "ref": ref}


class Observation:
    """One cycle's reading. Resolution needs explicit healthy evidence; everything else is held."""

    def __init__(self):
        self.incidents = {}      # key -> incident (conditions present now)
        self.healthy = set()     # (project, agent) explicitly observed alive with a contact promise
        self.hold = set()        # (project, agent) we could not judge this cycle
        self.failures = {}       # scope -> kind of a required read that failed
        self.delivery = None     # None | complete | incomplete | disabled | unavailable | failed
        self.coverage = []
        self.rows = []

    def fail(self, scope, kind):
        self.failures.setdefault(scope, kind)


def evaluate_agents(project, payload, obs):
    rows = payload.get("agents") if type(payload) is dict else None
    if type(rows) is not list:
        obs.fail("agents:" + project, "payload")
        return
    for row in rows:
        if type(row) is not dict or not ident(row.get("id")) or row.get("kind") != "agent":
            continue
        pair = (project, row["id"])
        live, wake = row.get("liveness"), row.get("wake_profile")
        state = live.get("state") if type(live) is dict else None
        if state not in LIVE_STATES:
            obs.hold.add(pair)
            obs.coverage.append("no_liveness:" + project)  # older server or malformed row
            continue
        promise = type(wake) is dict and type(wake.get("expected_contact_seconds")) is int
        obs.rows.append({"project": project, "id": row["id"], "state": state, "scope": live.get("scope"),
                         "reason": live.get("reason"), "last_contact_at": live.get("last_contact_at"),
                         "mode": wake.get("mode") if type(wake) is dict else None, "promise": promise})
        if not promise:
            obs.hold.add(pair)  # no declared cadence: quiet is idle, and a vanished promise is not a recovery
        elif state in ("silent", "dead") and live.get("scope") == "complete":
            key = "agent/%s/%s" % pair
            obs.incidents[key] = incident(key, "agent_contact", "crit" if state == "dead" else "warn", row["id"], project)
        elif state == "alive":
            obs.healthy.add(pair)
        else:
            obs.hold.add(pair)
            if live.get("reason") in ("partial_visibility", "reporting_blocked", "clock_anomaly"):
                obs.coverage.append("%s:%s:%s" % (live["reason"], project, row["id"]))


def _fetch_delivery_pages(transport, key):
    """Return (alerts, policy, complete) or raise MonitorError. 400/409 restarts once; a malformed page fails."""
    for attempt in range(2):
        alerts, cursor, pages = [], None, 0
        while True:
            path = "/v1/admin/delivery-alerts?limit=100" + ("&cursor=" + quote(cursor, safe="") if cursor else "")
            status, payload = transport.get_json(path, key)
            if status in (400, 409):
                break  # cursor invalid or policy changed: discard this traversal
            if status == 404:
                raise MonitorError("unavailable", "no delivery alerts endpoint")
            if (status != 200 or type(payload) is not dict or type(payload.get("alerts")) is not list
                    or type(payload.get("policy")) is not dict or type(payload["policy"].get("enabled")) is not bool
                    or type(payload.get("truncated")) is not bool):
                raise MonitorError("payload", "unexpected delivery response")
            alerts.extend(payload["alerts"])
            pages += 1
            if not payload["truncated"]:
                return alerts, payload["policy"], True
            following = payload.get("next_cursor")
            if (type(following) is not str or CURSOR.match(following) is None or pages >= MAX_PAGES
                    or len(alerts) >= MAX_ALERT_ROWS):
                return alerts, payload["policy"], False  # more rows exist than we can prove we read
            cursor = following
    raise MonitorError("cursor", "delivery cursor kept failing")


def read_delivery(transport, key, config, obs):
    projects = set(config["projects"])
    try:
        alerts, policy, complete = _fetch_delivery_pages(transport, key)
    except MonitorError as error:
        if error.kind == "auth":  # an agent key cannot read the owner-only list: coverage, not a failure
            obs.coverage.append("delivery_alerts_need_owner_key")
            obs.delivery = "unavailable"
        elif error.kind == "unavailable":
            obs.coverage.append("delivery_alerts_unavailable")
            obs.delivery = "unavailable"
        else:
            obs.fail("delivery", error.kind)
            obs.delivery = "failed"
        return
    if policy["enabled"] is False:
        obs.delivery = "disabled"  # existing delivery incidents are held, never resolved by this
        if config.get("expect_delivery_alerts", True):
            obs.incidents["coverage/delivery-disabled"] = incident("coverage/delivery-disabled", "coverage", "info", "delivery")
        return
    obs.delivery = "complete" if complete else "incomplete"
    if not complete:
        obs.coverage.append("delivery_scan_incomplete")
    for alert in alerts:
        if (type(alert) is not dict or not ident(alert.get("message_id")) or not ident(alert.get("recipient_id"))
                or not ident(alert.get("project_id")) or alert.get("reason") not in ("unacknowledged", "unanswered")
                or alert["project_id"] not in projects):
            continue
        key_ = "delivery/%s/%s/%s" % (alert["project_id"], alert["message_id"], alert["recipient_id"])
        obs.incidents[key_] = incident(key_, "delivery", "crit" if alert["reason"] == "unacknowledged" else "warn",
                                       alert["recipient_id"], alert["project_id"], alert["message_id"])


def observe(transport, key, config, obs=None):
    obs = obs or Observation()
    for project in config["projects"]:
        scope = "agents:" + project
        try:
            status, payload = transport.get_json("/v1/projects/%s/agents" % project, key)
            if status == 200:
                evaluate_agents(project, payload, obs)
            else:
                obs.fail(scope, "http")
        except MonitorError as error:
            obs.fail(scope, error.kind)
        except Exception:  # one project's odd payload must not erase what another project proved
            obs.fail(scope, "payload")
    if config.get("delivery_alerts", True):
        try:
            read_delivery(transport, key, config, obs)
        except Exception:
            obs.fail("delivery", "payload")
            obs.delivery = "failed"
    return obs


# ---------------------------------------------------------------- state and incident lifecycle

def new_state():
    return {"version": VERSION, "incidents": {}, "pending": [], "api_failures": 0, "last_run_wall": 0.0, "seq": 0, "dropped": 0}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_state(state):
    """Deep structural validation: anything else is a monitor fault, never a quietly empty baseline."""
    try:
        if type(state) is not dict or state.get("version") != VERSION:
            return False
        for name in ("api_failures", "seq", "dropped"):
            if type(state.get(name)) is not int or state[name] < 0:
                return False
        if not _number(state.get("last_run_wall")):
            return False
        incidents, pending = state.get("incidents"), state.get("pending")
        if type(incidents) is not dict or type(pending) is not list or len(incidents) > MAX_INCIDENTS or len(pending) > MAX_PENDING + 1:
            return False
        for key, entry in incidents.items():
            if type(key) is not str or len(key) > 600 or type(entry) is not dict:
                return False
            if entry.get("k") not in KINDS or entry.get("v") not in SEVERITY_RANK:
                return False
            if type(entry.get("s")) is not str or STATE_TEXT.match(entry["s"]) is None:
                return False
            for name in ("p", "r"):
                if entry.get(name) is not None and not (type(entry[name]) is str and STATE_TEXT.match(entry[name])):
                    return False
            if not _number(entry.get("f")) or not _number(entry.get("l")):
                return False
            for name in ("n", "h"):
                if type(entry.get(name)) is not int or entry[name] < 0:
                    return False
            notified = entry.get("t")
            if notified is not None and not (type(notified) is dict and notified.get("v") in SEVERITY_RANK and _number(notified.get("at"))):
                return False
        for item in pending:
            if (type(item) is not dict or type(item.get("id")) is not str or len(item["id"]) > 80 or item.get("event") not in EVENTS
                    or item.get("severity") not in SEVERITY_RANK or type(item.get("kind")) is not str
                    or type(item.get("subject")) is not str or type(item.get("summary")) is not str or len(item["summary"]) > 500
                    or type(item.get("host")) is not str or not _number(item.get("observed_at")) or not _number(item.get("first_seen"))
                    or type(item.get("attempts")) is not int or item["attempts"] < 0):
                return False
        return True
    except Exception:
        return False


class StateStore:
    def __init__(self, path):
        self.path = path
        self.lock_path = path + ".lock"
        self._lock = None

    def _directory(self):
        directory = os.path.dirname(self.path)
        try:
            info = os.lstat(directory)
        except FileNotFoundError:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise MonitorError("config", "state directory must be a directory you own that others cannot write")
        return directory

    def lock(self):
        self._directory()
        try:
            descriptor = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        except OSError as error:
            raise MonitorError("config", "cannot open the state lock") from error
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            os.close(descriptor)
            raise MonitorError("config", "state lock must be a regular file you own")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(descriptor)
            raise MonitorError("busy", "another monitor run holds the state lock") from None
        self._lock = descriptor

    def unlock(self):
        if self._lock is not None:
            os.close(self._lock)
            self._lock = None

    def load(self):
        """Return (state, fault)."""
        try:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return new_state(), None
        except OSError:
            return new_state(), "state_unreadable"
        try:
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError("not a regular file")
                raw = stream.read(MAX_STATE_BYTES + 1)
            if len(raw) > MAX_STATE_BYTES:
                raise ValueError("too large")
            state = json.loads(raw.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not valid_state(state):
                raise ValueError("shape")
            return state, None
        except (ValueError, UnicodeError, OSError, RecursionError):
            try:
                os.replace(self.path, "%s.corrupt-%d" % (self.path, int(time.time())))
            except OSError:
                pass
            return new_state(), "state_corrupt"

    def save(self, state):
        directory = os.path.dirname(self.path)
        raw = json.dumps(state, sort_keys=True, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_STATE_BYTES:
            raise MonitorError("state", "state too large")
        descriptor, temporary = tempfile.mkstemp(prefix=".state-", dir=directory)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            dirfd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except OSError as error:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise MonitorError("state", "cannot persist state: %s" % type(error).__name__) from error


def room(state):
    return len(state["pending"]) < MAX_PENDING


def enqueue(state, event, view, now, host):
    state["seq"] += 1
    summary = describe(view["kind"], view["severity"], view["subject"], view.get("ref"))
    if event == "resolved":
        summary = "recovered: " + summary
    first_seen = view.get("first_seen", now)
    state["pending"].append({
        "id": "%s-%d" % (hashlib.sha256(("%s|%s|%s" % (host, view["key"], first_seen)).encode()).hexdigest()[:16], state["seq"]),
        "event": event, "severity": "info" if event == "resolved" else view["severity"], "kind": view["kind"],
        "subject": view["subject"], "summary": summary, "project": view.get("project"), "first_seen": first_seen,
        "observed_at": now, "host": host, "attempts": 0})


def _view(key, entry):
    return {"key": key, "kind": entry["k"], "severity": entry["v"], "subject": entry["s"], "project": entry.get("p"),
            "ref": entry.get("r"), "first_seen": entry["f"]}


def resolvable(entry, obs):
    """Only explicit healthy evidence resolves an incident; a blind or partial read never does."""
    kind = entry["k"]
    if kind == "agent_contact":
        return (entry.get("p"), entry["s"]) in obs.healthy
    if kind == "delivery":
        return obs.delivery == "complete"
    if kind == "coverage":
        return obs.delivery in ("complete", "incomplete")  # the policy was seen enabled
    return not obs.failures  # api / config: every required read succeeded


def advance(state, obs, config, now, host):
    """Apply one observation to the persisted incident book. Pure apart from `state`."""
    confirm = config.get("confirm_observations", 2)
    renotify = config.get("renotify_seconds", 4 * 3600)
    threshold = config.get("api_failures_before_alert", 3)
    book = state["incidents"]
    if now < state["last_run_wall"] - 300:  # wall clock went backwards: rebaseline reminder timers
        for entry in book.values():
            if entry["t"]:
                entry["t"]["at"] = now
    desired = dict(obs.incidents)
    kinds = set(obs.failures.values())
    if kinds:
        state["api_failures"] += 1
        for kind in sorted(kinds & CONFIG_KINDS):
            desired["config/" + kind] = incident("config/" + kind, "config", "crit", kind)
        if kinds - CONFIG_KINDS and state["api_failures"] >= threshold:
            desired["api/unreachable"] = incident("api/unreachable", "api", "crit", "server")
    else:
        state["api_failures"] = 0
    overflow = False
    for key, current in desired.items():
        entry = book.get(key)
        if entry is None:
            if len(book) >= MAX_INCIDENTS:
                overflow = True
                continue
            entry = book[key] = {"k": current["kind"], "p": current["project"], "s": current["subject"], "r": current["ref"],
                                 "f": now, "l": now, "n": 0, "h": 0, "v": current["severity"], "t": None}
        entry["n"] += 1
        entry["h"] = 0
        entry["l"] = now
        entry["v"] = current["severity"]
        # api/config incidents are already confirmed by their own failure counters.
        required = 1 if current["kind"] in ("config", "api") else confirm
        notified = entry["t"]
        if notified is None:
            if entry["n"] >= required:
                if room(state):
                    enqueue(state, "open", _view(key, entry), now, host)
                    entry["t"] = {"v": entry["v"], "at": now}
                else:
                    overflow = True  # backpressure: stay un-notified and retry, never drop silently
        elif SEVERITY_RANK[entry["v"]] > SEVERITY_RANK[notified["v"]]:
            if room(state):
                enqueue(state, "escalate", _view(key, entry), now, host)
                entry["t"] = {"v": entry["v"], "at": now}
            else:
                overflow = True
        elif now - notified["at"] >= renotify:
            if room(state):
                enqueue(state, "reminder", _view(key, entry), now, host)
                notified["at"] = now
            else:
                overflow = True
    for key in list(book):
        if key in desired or not resolvable(book[key], obs):
            continue
        entry = book[key]
        entry["h"] += 1
        entry["n"] = 0
        if entry["h"] >= (1 if entry["k"] == "config" else confirm):
            if entry["t"] is not None:
                if not room(state):
                    overflow = True
                    continue
                enqueue(state, "resolved", _view(key, entry), now, host)
            del book[key]
    if not overflow:
        state["overflowing"] = False
    elif not state.get("overflowing"):
        state["overflowing"] = True
        state["seq"] += 1
        state["pending"].append({"id": "overflow-%d" % state["seq"], "event": "overflow", "severity": "crit", "kind": "monitor",
                                 "subject": "monitor", "summary": "notification backlog or incident limit reached; some incidents are waiting to be reported",
                                 "project": None, "first_seen": now, "observed_at": now, "host": host, "attempts": 0})
    state["last_run_wall"] = now


# ---------------------------------------------------------------- notification

def run_hook(command, notification, timeout):
    """Fixed operator argv, no shell, bounded JSON on stdin, minimal environment (no Mesh key), output discarded."""
    payload = json.dumps({k: v for k, v in notification.items() if k != "attempts"}, sort_keys=True).encode("utf-8")
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    try:
        done = subprocess.run(command, input=payload, env=environment, timeout=timeout, shell=False,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except subprocess.TimeoutExpired as error:
        raise MonitorError("hook", "notify command timed out") from error
    except OSError as error:
        raise MonitorError("hook", "cannot run notify command: %s" % type(error).__name__) from error
    if done.returncode != 0:
        raise MonitorError("hook", "notify command exited %d" % done.returncode)


def line(notification):
    return "NOTIFY %s %s %s %s" % (notification["event"], notification["severity"], notification["kind"],
                                   re.sub(r"[^\x20-\x7e]", "?", notification["summary"])[:300])


def deliver(state, config, out, persist=None):
    """At-least-once: a notification leaves the queue only after the hook succeeded, and that is persisted."""
    notify = config.get("notify") or {}
    hook, timeout = notify.get("command"), notify.get("timeout_seconds", 20)
    failed = False
    for notification in list(state["pending"]):
        out(line(notification))
        if not hook:
            state["pending"].remove(notification)
            continue
        try:
            run_hook(hook, notification, timeout)
        except MonitorError as error:
            notification["attempts"] += 1
            failed = True
            out("monitor: %s (%s)" % (error, notification["id"]))
            continue
        state["pending"].remove(notification)
        if persist:
            persist()
    return not failed


def heartbeat(url_file):
    """Independent dead-man ping; the receiver should alert when it stops arriving."""
    url = read_private_text(url_file, "heartbeat_url_file").strip()
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise MonitorError("config", "heartbeat URL must be https")
    connection = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=10, context=ssl.create_default_context())
    try:
        connection.connect()
    except (OSError, http.client.HTTPException) as error:
        connection.close()
        raise MonitorError("heartbeat", type(error).__name__) from error
    watchdog = threading.Timer(READ_DEADLINE_SECONDS, _kill, (connection.sock,))
    watchdog.daemon = True
    watchdog.start()
    try:
        connection.request("GET", (parts.path or "/") + ("?" + parts.query if parts.query else ""), headers={"User-Agent": "agent-link-monitor/%d" % VERSION})
        status = connection.getresponse().status
    except (OSError, http.client.HTTPException) as error:
        raise MonitorError("heartbeat", type(error).__name__) from error
    finally:
        watchdog.cancel()
        connection.close()
    if not 200 <= status < 300:
        raise MonitorError("heartbeat", "receiver answered %d" % status)


# ---------------------------------------------------------------- files, config, entry points

def read_private_text(path, label, limit=65536):
    """Regular, non-symlink, owner-only file. Opened non-blocking so a FIFO cannot hang the monitor."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise MonitorError("config", "cannot open %s" % label) from error
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise MonitorError("config", "%s must be a regular file owned by you with mode 0600" % label)
        try:
            return stream.read(limit + 1)[:limit].decode("utf-8", errors="strict")
        except UnicodeError as error:
            raise MonitorError("config", "%s is not text" % label) from error


def load_config(path):
    try:
        config = json.loads(read_private_text(path, "config"))
    except (ValueError, RecursionError) as error:
        raise MonitorError("config", "config is not valid JSON") from error
    if type(config) is not dict:
        raise MonitorError("config", "config must be an object")
    for name in ("origin", "pin", "key_file", "state_file"):
        if type(config.get(name)) is not str:
            raise MonitorError("config", "missing %s" % name)
    projects = config.get("projects")
    if type(projects) is not list or not projects or len(projects) > 50 or not all(ident(p) for p in projects):
        raise MonitorError("config", "projects must be a list of 1..50 project IDs")
    for name in ("key_file", "state_file", "ca_file", "heartbeat_url_file"):
        if name in config and not (type(config[name]) is str and os.path.isabs(config[name])):
            raise MonitorError("config", "%s must be an absolute path" % name)
    notify = config.get("notify", {})
    if type(notify) is not dict:
        raise MonitorError("config", "notify must be an object")
    command = notify.get("command")
    if command is not None and not (type(command) is list and command and all(type(a) is str for a in command) and os.path.isabs(command[0])):
        raise MonitorError("config", "notify.command must be an argv list starting with an absolute path (no shell)")
    if "timeout_seconds" in notify and not (type(notify["timeout_seconds"]) is int and 1 <= notify["timeout_seconds"] <= 120):
        raise MonitorError("config", "notify.timeout_seconds must be an integer 1..120")
    for name, low, high in (("confirm_observations", 1, 10), ("renotify_seconds", 300, 7 * 86400), ("api_failures_before_alert", 1, 100)):
        if name in config and not (type(config[name]) is int and low <= config[name] <= high):
            raise MonitorError("config", "%s out of range" % name)
    if "verify" in config and config["verify"] not in ("ca", "pin_only"):
        raise MonitorError("config", "verify must be 'ca' or 'pin_only'")
    return config


def read_key(path):
    key = read_private_text(path, "key_file").strip()
    if KEY_TEXT.match(key) is None:
        raise MonitorError("config", "key_file does not contain a plausible key")
    return key


def make_transport(config):
    # CA verification is the default. "pin_only" (no CA chain; the exact server key is pinned and
    # checked BEFORE any credential is sent) must be chosen explicitly, e.g. for a self-signed server.
    return Transport(config["origin"], config["pin"], config.get("ca_file"), verify=config.get("verify", "ca"))


def run_once(config, out=print, now=None, transport=None):
    """One cycle. Returns 0 healthy, 1 degraded (could not read, notify or persist completely)."""
    now = time.time() if now is None else now
    host = config.get("label") or urlsplit(config["origin"]).hostname
    store = StateStore(config["state_file"])
    store.lock()
    try:
        state, fault = store.load()
        if fault:
            out("monitor: %s; rebuilding a fresh baseline" % fault)
            state["seq"] += 1
            state["pending"].append({"id": "fault-%d" % state["seq"], "event": "open", "severity": "crit", "kind": "monitor",
                                     "subject": "monitor", "summary": "monitor state was %s; incident history was reset" % fault.replace("_", " "),
                                     "project": None, "first_seen": now, "observed_at": now, "host": host, "attempts": 0})
        obs = Observation()
        try:
            key = read_key(config["key_file"])
            transport = transport or make_transport(config)
        except MonitorError:
            obs.fail("setup", "config")  # an unreadable key or bad CA still reaches the notification hook
            transport = None
        if transport is not None:
            observe(transport, key, config, obs)
        advance(state, obs, config, now, host)
        store.save(state)                                  # persist the outbox BEFORE any hook runs
        delivered = deliver(state, config, out, persist=lambda: store.save(state))
        store.save(state)
    finally:
        store.unlock()
    complete = (not obs.failures and obs.delivery not in ("incomplete", "failed") and delivered and not fault)
    for item in sorted(set(obs.coverage)):
        out("coverage: %s" % item)
    if complete and config.get("heartbeat_url_file"):
        try:
            heartbeat(config["heartbeat_url_file"])
        except MonitorError as error:
            out("monitor: %s" % error)
            return 1
    return 0 if complete else 1


def age_text(then, now):
    if then is None:
        return "never"
    seconds = int(max(0, now - then))
    for size, unit in ((86400, "d"), (3600, "h"), (60, "m")):
        if seconds >= size:
            return "%d%s ago" % (seconds // size, unit)
    return "%ds ago" % seconds


def status(config, out=print, transport=None):
    """Read-only operator view: what the server concludes right now. No state, no notifications."""
    obs = Observation()
    try:
        key = read_key(config["key_file"])
        observe(transport or make_transport(config), key, config, obs)
    except MonitorError as error:
        obs.fail("setup", error.kind)
    out("api: %s" % ("OK" if not obs.failures else "ERROR " + ",".join(sorted(set(obs.failures.values())))))
    now = time.time()
    for row in sorted(obs.rows, key=lambda r: (r["project"], r["id"])):
        out("%-14s %-8s %-9s last contact %-10s mode=%-9s promise=%-3s scope=%s%s" % (
            row["id"], row["state"], row["project"], age_text(parse_time(row["last_contact_at"]), now), row["mode"] or "-",
            "yes" if row["promise"] else "no", row["scope"], " reason=" + row["reason"] if row["reason"] else ""))
    for current in sorted(obs.incidents.values(), key=lambda c: c["key"]):
        out("INCIDENT %s %s %s" % (current["severity"], current["kind"],
                                   describe(current["kind"], current["severity"], current["subject"], current["ref"])))
    for item in sorted(set(obs.coverage)):
        out("coverage: %s" % item)
    return 0 if not obs.failures else 1


def show_pin(origin):
    """Print the server key pin (trust it only after comparing it through a channel you trust)."""
    parts = urlsplit(origin)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
    connection = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=10, context=context)
    try:
        connection.connect()
        return spki_pin(connection.sock.getpeercert(binary_form=True))
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", help="absolute path of the monitor JSON config (mode 0600)")
    parser.add_argument("--status", action="store_true", help="print the server's current conclusions and exit; changes nothing")
    parser.add_argument("--test-notify", action="store_true", help="send one test notification through the configured command")
    parser.add_argument("--show-pin", metavar="ORIGIN", help="print the SPKI pin of a server (no credential is sent)")
    args = parser.parse_args(argv)
    try:
        if args.show_pin:
            print(show_pin(args.show_pin))
            return 0
        if not args.config or not os.path.isabs(args.config):
            parser.error("--config must be an absolute path")
        config = load_config(args.config)
        if args.test_notify:
            state = new_state()
            enqueue(state, "test", {"key": "test", "severity": "info", "kind": "test", "subject": "monitor",
                                    "summary": "test notification from agent-link-monitor", "project": None}, time.time(), config.get("label") or "host")
            return 0 if deliver(state, config, print) else 1
        if args.status:
            return status(config)
        return run_once(config)
    except MonitorError as error:
        print("monitor: %s: %s" % (error.kind, error), file=sys.stderr)
        return 2 if error.kind == "config" else 1


if __name__ == "__main__":
    raise SystemExit(main())
