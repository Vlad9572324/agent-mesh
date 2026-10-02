#!/usr/bin/env python3
"""Agent Mesh local pilot: TLS REST polling + durable SQLite + owned CLI runtime."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import ssl
import stat
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener
import uuid

from runtimes import RuntimeFailure, make_runtime


class APIError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__("API request rejected: HTTP " + str(code))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an Authorization header to a redirect destination.
        return None


class Client:
    def __init__(self, url, key, ca_file=None, timeout=8):
        parsed = urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("URL must be a bare origin without credentials, path, query, or fragment")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1")):
            raise ValueError("HTTPS is required; HTTP is allowed only on literal loopback")
        if not parsed.hostname:
            raise ValueError("URL needs a host")
        self.url = url.rstrip("/")
        self.key = key
        self.timeout = timeout
        self.context = ssl.create_default_context(cafile=ca_file)

    def request(self, method, path, body=None):
        request = Request(self.url + path, method=method,
                          headers={"Authorization": "Bearer " + self.key, "Content-Type": "application/json"},
                          data=None if body is None else json.dumps(body, ensure_ascii=False).encode())
        # Per-call opener avoids shared mutable urllib state between heartbeat/main threads.
        opener = build_opener(NoRedirect(), ProxyHandler({}), HTTPSHandler(context=self.context))
        try:
            with opener.open(request, timeout=self.timeout) as response:
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise ValueError("API response too large")
                return json.loads(data) if data else {}
        except HTTPError as exc:
            raise APIError(exc.code) from None


def read_key(path, agent_id):
    path = Path(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError("key file must be a regular private file (0600)")
    raw = path.read_text().strip()
    if raw.startswith("{"):
        obj = json.loads(raw)
        if "key" in obj:
            raw = obj.get("key", "") if obj.get("agent_id") == agent_id else ""
        else:
            key_map = obj.get("keys", obj)
            raw = key_map.get(agent_id, "") if isinstance(key_map, dict) else ""
    if not isinstance(raw, str) or len(raw) < 32 or any(c.isspace() for c in raw):
        raise ValueError("key file has no valid individual key for this agent")
    return raw


def log(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


class Store:
    def __init__(self, path, identity):
        path = Path(path).absolute()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_file = open(str(path) + ".lock", "a+")
        os.chmod(str(path) + ".lock", 0o600)
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            raise ValueError("another adapter owns this SQLite database") from None
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inbox(
                id TEXT PRIMARY KEY, seq INTEGER NOT NULL, message TEXT NOT NULL,
                state TEXT NOT NULL, runtime_session TEXT, accepted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS outbox(
                id INTEGER PRIMARY KEY AUTOINCREMENT, unique_key TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
                sent INTEGER NOT NULL DEFAULT 0);
        """)
        prior = self.get("identity")
        if prior and prior != identity:
            self.close()
            raise ValueError("database belongs to a different server, agent, or channel")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO meta VALUES('identity',?)", (identity,))
            # A new process always has a new lease. Queued inputs may be rebound
            # by re-sending delivered; runtime acceptance may not be fabricated
            # under this new runtime. Keep superseded receipts locally as sent=2.
            for row in self.db.execute("SELECT id,state FROM inbox").fetchall():
                if row["state"] == "queued":
                    self.db.execute("UPDATE outbox SET sent=0 WHERE unique_key=?", (row["id"] + ":delivered",))
                elif row["state"] in ("dispatching", "completed", "uncertain"):
                    self.db.execute("UPDATE outbox SET sent=2 WHERE unique_key=? AND sent=0", (row["id"] + ":accepted",))
            # Dispatch is irreversible locally: after a crash never invoke the runtime again.
            for row in self.db.execute("SELECT id FROM inbox WHERE state='dispatching'").fetchall():
                self.db.execute("UPDATE inbox SET state='uncertain' WHERE id=?", (row["id"],))
                self._enqueue_receipt(row["id"], "uncertain")

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    @property
    def cursor(self):
        return int(self.get("cursor", "0"))

    def _enqueue(self, key, kind, path, body):
        self.db.execute("INSERT OR IGNORE INTO outbox(unique_key,kind,path,body) VALUES(?,?,?,?)",
                        (key, kind, path, json.dumps(body, ensure_ascii=False)))

    def _enqueue_receipt(self, message_id, status):
        self._enqueue(message_id + ":" + status, "receipt", "/v1/messages/" + quote(message_id, safe="") + "/receipts", {"status": status})

    def ingest(self, messages, agent_id):
        with self.db:
            cursor = self.cursor
            for message in messages:
                addressed = agent_id in (message.get("recipient_ids") or [])
                prior = next((r for r in (message.get("receipts") or []) if r.get("agent_id") == agent_id), {})
                terminal = bool(prior.get("accepted_at") or prior.get("uncertain_at"))
                wakes = addressed and not message.get("reply_to") and message.get("author_id") != agent_id
                state = ("uncertain" if prior.get("uncertain_at") else "previously_accepted") if terminal else ("queued" if wakes else "observed")
                inserted = self.db.execute("INSERT OR IGNORE INTO inbox(id,seq,message,state) VALUES(?,?,?,?)",
                    (message["id"], message["seq"], json.dumps(message, ensure_ascii=False), state)).rowcount
                # A fresh database still must not replay a server-acknowledged or
                # uncertain dispatch, nor try to rebind its historical receipt.
                if inserted and addressed and not terminal:
                    self._enqueue_receipt(message["id"], "delivered")
                cursor = max(cursor, int(message["seq"]))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('cursor',?)", (str(cursor),))

    def next_message(self):
        row = self.db.execute("SELECT message FROM inbox WHERE state='queued' ORDER BY seq LIMIT 1").fetchone()
        return json.loads(row[0]) if row else None

    def dispatch(self, message_id):
        with self.db:
            changed = self.db.execute("UPDATE inbox SET state='dispatching' WHERE id=? AND state='queued'", (message_id,)).rowcount
        if not changed:
            raise ValueError("message is not dispatchable")

    def accept(self, message_id, runtime_session):
        with self.db:
            self.db.execute("UPDATE inbox SET accepted=1,runtime_session=? WHERE id=? AND state='dispatching'", (runtime_session, message_id))
            self._enqueue_receipt(message_id, "accepted")

    def complete(self, message, reply, agent_id):
        # Stable across a lost POST response and process restart; independent of session id.
        client_id = hashlib.sha256((agent_id + ":reply:" + message["id"]).encode()).hexdigest()
        with self.db:
            self._enqueue(client_id, "message", "/v1/channels/" + quote(message["channel_id"], safe="") + "/messages",
                {"client_id": client_id, "body": reply.encode("utf-8")[:12000].decode("utf-8", errors="ignore"),
                 "recipient_ids": [message["author_id"]], "reply_to": message["id"]})
            self.db.execute("UPDATE inbox SET state='completed' WHERE id=?", (message["id"],))

    def uncertain(self, message_id):
        with self.db:
            self.db.execute("UPDATE inbox SET state='uncertain' WHERE id=?", (message_id,))
            self._enqueue_receipt(message_id, "uncertain")

    def flush(self, client, session_id):
        for row in self.db.execute("SELECT * FROM outbox WHERE sent=0 ORDER BY id").fetchall():
            body = json.loads(row["body"])
            if row["kind"] == "receipt":
                body["session_id"] = session_id
            response = client.request("POST", row["path"], body)
            with self.db:
                self.db.execute("UPDATE outbox SET sent=1 WHERE id=?", (row["id"],))
            if row["kind"] == "message":
                log("reply_published", message_id=response.get("message", {}).get("id"), replayed=response.get("replayed", False))

    def close(self):
        self.db.close()
        self.lock_file.close()


class Adapter:
    def __init__(self, client, store, agent_id, channel, runtime_name, max_turns=2,
                 poll_interval=1, runtime_timeout=120, model=None, heartbeat_interval=5):
        self.client, self.store = client, store
        self.agent_id, self.channel, self.runtime_name = agent_id, channel, runtime_name
        self.max_turns, self.poll_interval = max_turns, poll_interval
        self.runtime_timeout, self.model = runtime_timeout, model
        self.heartbeat_interval = heartbeat_interval
        self.session_id = str(uuid.uuid4())
        self.stop = threading.Event()
        self.runtime = None
        self.activity = "starting; polling"
        self.fatal = None
        self.last_heartbeat = 0.0
        self.turns = 0

    def heartbeat(self):
        self.client.request("POST", "/v1/heartbeat", {"session_id": self.session_id,
            "activity": self.activity[:240], "runtime": self.runtime_name})
        self.last_heartbeat = time.monotonic()

    def _heartbeats(self):
        while not self.stop.wait(self.heartbeat_interval):
            try:
                self.heartbeat()
            except APIError as exc:
                if exc.code in (401, 403, 404, 409):
                    self.fatal = exc
                    self.stop.set()
                    if self.runtime:
                        self.runtime.close()
                    return
            except (OSError, URLError, ValueError):
                pass
            if time.monotonic() - self.last_heartbeat >= 20:
                self.fatal = RuntimeFailure("heartbeat lease cannot be maintained")
                self.stop.set()
                if self.runtime:
                    self.runtime.close()
                return

    def step(self):
        self.store.flush(self.client, self.session_id)
        messages = self.client.request("GET", "/v1/channels/" + quote(self.channel, safe="") +
            "/messages?after_seq=" + str(self.store.cursor) + "&limit=100").get("messages", [])
        self.store.ingest(messages, self.agent_id)
        self.store.flush(self.client, self.session_id)
        message = self.store.next_message()
        if not message or self.turns >= self.max_turns or self.stop.is_set():
            return
        # A synchronous lease check immediately before dispatch fences stale owners.
        self.heartbeat()
        self.store.dispatch(message["id"])
        self.turns += 1
        self.activity = "responding; polling"
        log("runtime_dispatch", message_id=message["id"], runtime=self.runtime_name,
            runtime_session=self.runtime.session_id, turn=self.turns)

        def accepted(runtime_session):
            self.store.accept(message["id"], runtime_session)
            log("runtime_accepted", message_id=message["id"], runtime_session=runtime_session)
            # Receipts remain durable if the server is briefly unavailable.
            try:
                self.store.flush(self.client, self.session_id)
            except APIError as exc:
                if exc.code < 500:
                    raise
            except (OSError, URLError):
                pass

        try:
            reply = self.runtime.reply(message, accepted)
            if self.stop.is_set():
                raise RuntimeFailure("runtime interrupted by lost authorization or lease")
            self.store.complete(message, reply, self.agent_id)
            log("runtime_completed", message_id=message["id"], runtime_session=self.runtime.session_id,
                capabilities=getattr(self.runtime, "capabilities", {}))
        except BaseException as exc:
            self.store.uncertain(message["id"])
            log("dispatch_uncertain", message_id=message["id"], replay="operator decision required; never automatic")
            if not self.stop.is_set():
                try:
                    self.store.flush(self.client, self.session_id)
                except (APIError, OSError, URLError):
                    pass
            # Once input was dispatched, even transport-looking runtime errors
            # must stop this child. Retrying the main loop could overlap turns.
            if isinstance(exc, (RuntimeFailure, APIError, KeyboardInterrupt, SystemExit)):
                raise
            raise RuntimeFailure("runtime dispatch outcome uncertain; child must be stopped") from exc
        finally:
            self.activity = "idle; polling" if self.turns < self.max_turns else "turn budget exhausted; polling"
        self.store.flush(self.client, self.session_id)

    def run(self, run_seconds=0):
        me = self.client.request("GET", "/v1/me").get("agent", {})
        if me.get("id") != self.agent_id or me.get("kind") != "agent":
            raise ValueError("key identity does not match the requested agent")
        self.heartbeat()  # Acquire lease before starting a model child.
        heartbeat_thread = threading.Thread(target=self._heartbeats, daemon=True)
        heartbeat_thread.start()
        started = time.monotonic()
        try:
            self.runtime = make_runtime(self.runtime_name, model=self.model, timeout=self.runtime_timeout)
            self.activity = "idle; polling"
            log("adapter_ready", agent_id=self.agent_id, session_id=self.session_id,
                runtime_session=self.runtime.session_id, runtime=self.runtime_name,
                transport="ordered REST polling", max_turns=self.max_turns)
            while not self.stop.is_set() and (not run_seconds or time.monotonic() - started < run_seconds):
                try:
                    self.step()
                except APIError as exc:
                    if exc.code < 500:
                        raise
                    log("transport_retry", reason="server unavailable")
                except (OSError, URLError):
                    log("transport_retry", reason="network unavailable")
                self.stop.wait(self.poll_interval)
            if self.fatal:
                raise self.fatal
        finally:
            self.stop.set()
            heartbeat_thread.join(timeout=10)
            if self.runtime:
                self.runtime.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--key-file", required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--channel", default="general")
    parser.add_argument("--db", required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--runtime", choices=("claude", "codex", "echo"), required=True)
    parser.add_argument("--model", help="optional explicit model; otherwise CLI default (Claude sonnet)")
    parser.add_argument("--max-turns", type=int, default=2)
    parser.add_argument("--poll-interval", type=float, default=1)
    parser.add_argument("--runtime-timeout", type=float, default=120)
    parser.add_argument("--run-seconds", type=float, default=0, help="0 keeps polling until stopped, including after turn budget")
    args = parser.parse_args(argv)
    if args.max_turns < 0 or args.poll_interval < 0.1 or args.runtime_timeout < 1 or args.run_seconds < 0:
        parser.error("invalid budget or interval")
    os.umask(0o077)
    store = None
    adapter = None
    try:
        client = Client(args.url, read_key(args.key_file, args.agent_id), args.ca_file)
        identity = json.dumps([client.url, args.agent_id, args.channel])
        store = Store(args.db, identity)
        adapter = Adapter(client, store, args.agent_id, args.channel, args.runtime, args.max_turns,
                          args.poll_interval, args.runtime_timeout, args.model)
        def stop_handler(*_):
            adapter.stop.set()
            if adapter.runtime:
                adapter.runtime.close()
        signal.signal(signal.SIGINT, stop_handler)
        signal.signal(signal.SIGTERM, stop_handler)
        adapter.run(args.run_seconds)
        return 0
    except (APIError, RuntimeFailure, ValueError, OSError, URLError) as exc:
        # HTTP errors never include response bodies, URLs, or Authorization values.
        log("adapter_stopped", reason=str(exc) if isinstance(exc, (APIError, RuntimeFailure, ValueError)) else type(exc).__name__)
        return 2
    finally:
        if adapter and adapter.runtime:
            adapter.runtime.close()
        if store:
            store.close()


if __name__ == "__main__":
    sys.exit(main())
