"""Provider-neutral, opt-in local Runtime Host.

The mesh supplies message identifiers.  Only a private local policy supplies an
executable and arguments; message bodies can therefore never become commands.
"""
import json
import os
from pathlib import Path
import re
import select
import sqlite3
import stat
import subprocess
import time
import uuid

from coordination import CoordinationError, canonical, identifier, origin_identity
from runtime_protocol import (MAX_FRAME_BYTES, ProtocolError, decode_frame,
                              negotiate_version, validate_message, write_frame)


class HostError(ValueError):
    pass


TERMINAL = ("done", "error", "cancelled", "uncertain")


def _private_dir(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or (path.exists() and path.resolve() != path.absolute()):
        raise HostError("state_dir must be an absolute nonsymlink path")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.stat()
    if (path.resolve() != path.absolute() or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise HostError("state_dir must be private and owned by this user")
    return path


def load_policy(path):
    """Load an exact, private policy. Unknown fields are rejected deliberately."""
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path.absolute():
        raise HostError("policy must be a private owned regular file")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 128 * 1024
                    or info.st_uid != os.getuid() or info.st_mode & 0o077):
                raise HostError("policy must be a private owned regular file")
            raw = stream.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            raise HostError("host policy is too large")
        def pairs(items):
            result = {}
            for key, item in items:
                if key in result:
                    raise HostError("duplicate host policy field")
                result[key] = item
            return result
        def invalid(_value):
            raise HostError("non-finite host policy number")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)
    except HostError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise HostError("invalid host policy") from None
    fields = {"version", "connector_config", "server_origin", "project_id", "state_dir",
              "route_id", "agent_id", "runtime", "argv",
              "working_directory", "env_allowlist",
              "poll_seconds", "handshake_seconds", "turn_seconds"}
    if type(value) is not dict or set(value) != fields or value.get("version") != 1:
        raise HostError("invalid host policy fields")
    for name in ("connector_config", "state_dir"):
        if type(value[name]) is not str or not Path(value[name]).is_absolute():
            raise HostError("absolute local paths required")
    if not all(identifier(value[name]) for name in ("project_id", "route_id", "agent_id", "runtime")):
        raise HostError("invalid route identity")
    try:
        if not origin_identity(value["server_origin"]).startswith("https://"):
            raise HostError("server_origin must be HTTPS")
    except (CoordinationError, TypeError, ValueError):
        raise HostError("invalid server_origin") from None
    argv = value["argv"]
    if (type(argv) is not list or not 1 <= len(argv) <= 32
            or any(type(v) is not str or not v or "\x00" in v or len(v.encode()) > 4096 for v in argv)):
        raise HostError("invalid fixed argv")
    executable = Path(argv[0])
    if not executable.is_absolute() or executable.is_symlink():
        raise HostError("argv executable must be an absolute nonsymlink path")
    exe_info = executable.stat()
    if not stat.S_ISREG(exe_info.st_mode) or not os.access(executable, os.X_OK):
        raise HostError("argv executable must be an executable regular file")
    working = Path(value["working_directory"])
    if (not working.is_absolute() or working.is_symlink() or not working.is_dir()
            or working.resolve() != working.absolute()):
        raise HostError("working_directory must be an absolute nonsymlink directory")
    allowlist = value["env_allowlist"]
    if (type(allowlist) is not list or len(allowlist) > 32 or len(set(allowlist)) != len(allowlist)
            or any(type(name) is not str or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name) is None
                   for name in allowlist)):
        raise HostError("invalid environment allowlist")
    for name, low, high in (("poll_seconds", 1, 300), ("handshake_seconds", 1, 60),
                            ("turn_seconds", 1, 3600)):
        if type(value[name]) is not int or not low <= value[name] <= high:
            raise HostError("invalid host time budget")
    return value


class RuntimeHost:
    """One durable controller for one locally configured runtime route."""

    def __init__(self, policy, *, popen=subprocess.Popen, clock=time.monotonic):
        self.policy, self.popen, self.clock = policy, popen, clock
        self.root = _private_dir(policy["state_dir"])
        dbpath = self.root / "runtime-host.sqlite3"
        fd = os.open(dbpath, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        os.close(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise HostError("journal must be private and owned")
        self.db = sqlite3.connect(dbpath)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS routes(route_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,
            epoch INTEGER NOT NULL,binding TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS wakes(wake_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,
            generation INTEGER NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,
            channel_id TEXT NOT NULL,sender_id TEXT NOT NULL,message_ids TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,
            detail TEXT);
          CREATE TABLE IF NOT EXISTS claims(message_id TEXT PRIMARY KEY,wake_id TEXT NOT NULL,
            released INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS baselines(message_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,
            created REAL NOT NULL);
        """)
        binding = canonical({key: policy[key] for key in (
            "connector_config", "server_origin", "project_id", "route_id", "agent_id", "runtime",
            "argv", "working_directory", "env_allowlist")})
        with self.db:
            old = self.db.execute("SELECT * FROM routes WHERE route_id=?", (policy["route_id"],)).fetchone()
            generation = 1 if old is None else old["generation"] + (old["binding"] != binding)
            epoch = 1 if old is None else old["epoch"] + 1
            self.db.execute("INSERT OR REPLACE INTO routes VALUES(?,?,?,?)",
                            (policy["route_id"], generation, epoch, binding))
            if old is not None and old["binding"] != binding:
                obsolete = [r[0] for r in self.db.execute(
                    "SELECT wake_id FROM wakes WHERE route_id=? AND state='queued'",
                    (policy["route_id"],))]
                self.db.execute("UPDATE wakes SET state='error',updated=?,detail='local_route_reconfigured' "
                                "WHERE route_id=? AND state='queued'", (time.time(), policy["route_id"]))
                self.db.executemany("UPDATE claims SET released=1 WHERE wake_id=?", ((v,) for v in obsolete))
            else:
                # A queued wake is proven pre-submission and may be adopted by the
                # newly fenced controller. Submitted states are never adopted.
                self.db.execute("UPDATE wakes SET epoch=? WHERE route_id=? AND state='queued' AND generation=?",
                                (epoch, policy["route_id"], generation))
        self.generation, self.epoch = generation, epoch
        # A prior process may have submitted a turn. Never infer it did not run.
        with self.db:
            self.db.execute("UPDATE wakes SET state='uncertain',updated=?,detail='host_restart_after_submission' "
                            "WHERE route_id=? AND state IN ('submitted','running')",
                            (time.time(), policy["route_id"]))

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None

    def enqueue(self, channel_id, message_ids, sender_id="mesh-server"):
        if not identifier(channel_id) or not identifier(sender_id) or type(message_ids) is not list or not message_ids \
                or len(message_ids) > 200 or not all(identifier(v) for v in message_ids):
            raise HostError("invalid wake identifiers")
        unique = list(dict.fromkeys(message_ids))
        with self.db:
            available = [mid for mid in unique if not self.db.execute(
                "SELECT 1 FROM claims WHERE message_id=? AND released=0 UNION ALL "
                "SELECT 1 FROM baselines WHERE message_id=?", (mid, mid)).fetchone()]
            if not available:
                return None
            wake_id = "wake-" + uuid.uuid4().hex
            now = time.time()
            self.db.execute("INSERT INTO wakes VALUES(?,?,?,?,?,?,?,?,?,?,NULL)",
                            (wake_id, self.policy["route_id"], self.generation, self.epoch,
                             "queued", channel_id, sender_id, canonical(available), now, now))
            # A prior binding change can leave a released claim row for the same
            # message (message_id is PRIMARY KEY). Replace it, so re-claiming an
            # again-available message never collides with the retired row.
            self.db.executemany("INSERT OR REPLACE INTO claims(message_id,wake_id,released) VALUES(?,?,0)",
                                ((mid, wake_id) for mid in available))
        return wake_id

    def baseline(self, message_ids):
        """Suppress pre-enrollment inbox IDs without asserting seen or accepted."""
        if (type(message_ids) is not list or len(message_ids) > 50000
                or not all(identifier(value) for value in message_ids)
                or len(set(message_ids)) != len(message_ids)):
            raise HostError("invalid baseline identifiers")
        before = self.db.total_changes
        with self.db:
            self.db.executemany("INSERT OR IGNORE INTO baselines VALUES(?,?,?)",
                                ((value, self.policy["route_id"], time.time()) for value in message_ids))
        return self.db.total_changes - before

    def _transition(self, wake_id, state, detail=None, *, generation=None, epoch=None):
        transitions = {
            "queued": {"submitted", "error", "cancelled"},
            "submitted": {"running", "error", "cancelled", "uncertain"},
            "running": set(TERMINAL),
            "done": set(), "error": set(), "cancelled": set(), "uncertain": set(),
        }
        if state not in transitions:
            raise HostError("invalid wake state")
        generation = self.generation if generation is None else generation
        epoch = self.epoch if epoch is None else epoch
        if generation != self.generation or epoch != self.epoch:
            raise HostError("stale route generation or epoch")
        with self.db:
            owner = self.db.execute("SELECT generation,epoch FROM routes WHERE route_id=?",
                                    (self.policy["route_id"],)).fetchone()
            if not owner or owner["generation"] != generation or owner["epoch"] != epoch:
                raise HostError("stale route generation or epoch")
            row = self.db.execute("SELECT * FROM wakes WHERE wake_id=?", (wake_id,)).fetchone()
            if not row or row["generation"] != generation or row["epoch"] != epoch:
                raise HostError("stale route generation or epoch")
            if state not in transitions[row["state"]]:
                raise HostError("invalid wake transition")
            self.db.execute("UPDATE wakes SET state=?,updated=?,detail=? WHERE wake_id=?",
                            (state, time.time(), detail, wake_id))
            # Claims remain durable after a terminal result: message evidence is
            # independent and an unaccepted message must not trigger a second turn.

    def _read_with_timeout(self, stream, seconds, buffer, should_stop=None):
        """Read one frame by deadline without BufferedReader/readline stalls."""
        fd = stream.fileno()
        deadline = self.clock() + seconds
        while True:
            if should_stop is not None and should_stop():
                raise InterruptedError("runtime dispatch interrupted")
            newline = buffer.find(b"\n")
            if newline >= 0:
                if newline + 1 > MAX_FRAME_BYTES:
                    raise ProtocolError("frame exceeds byte limit")
                frame = bytes(buffer[:newline + 1])
                del buffer[:newline + 1]
                return decode_frame(frame)
            if len(buffer) >= MAX_FRAME_BYTES:
                raise ProtocolError("frame exceeds byte limit")
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise TimeoutError("runtime frame timeout")
            wait = min(remaining, 0.1) if should_stop is not None else remaining
            ready, _, _ = select.select([fd], [], [], wait)
            if not ready:
                if self.clock() >= deadline:
                    raise TimeoutError("runtime frame timeout")
                continue
            chunk = os.read(fd, min(8192, MAX_FRAME_BYTES + 1 - len(buffer)))
            if not chunk:
                if not buffer:
                    return None
                raise ProtocolError("runtime closed with a partial frame")
            buffer.extend(chunk)

    def dispatch(self, wake_id, should_stop=None):
        owner = self.db.execute("SELECT generation,epoch FROM routes WHERE route_id=?",
                                (self.policy["route_id"],)).fetchone()
        if not owner or owner["generation"] != self.generation or owner["epoch"] != self.epoch:
            raise HostError("controller was fenced by a newer host")
        row = self.db.execute("SELECT * FROM wakes WHERE wake_id=?", (wake_id,)).fetchone()
        if not row or row["state"] != "queued" or row["generation"] != self.generation or row["epoch"] != self.epoch:
            raise HostError("wake is not dispatchable by this controller")
        if should_stop is not None and should_stop():
            return "queued"
        proc = None
        submitted = False
        try:
            # argv is copied only from the local private policy. No shell, message body,
            # server-provided executable, cwd, or environment mutation is accepted.
            proc = self.popen(tuple(self.policy["argv"]), stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              cwd=self.policy["working_directory"],
                              env={name: os.environ[name] for name in self.policy["env_allowlist"] if name in os.environ},
                              shell=False, close_fds=True)
            receive_buffer = bytearray()
            hello = validate_message(self._read_with_timeout(
                proc.stdout, self.policy["handshake_seconds"], receive_buffer, should_stop), {"hello"})
            if hello["agent_id"] != self.policy["agent_id"] or hello["runtime"] != self.policy["runtime"]:
                raise ProtocolError("runtime identity differs from local policy")
            version = negotiate_version(hello["proto"])
            if hello["v"] != version:
                raise ProtocolError("hello version differs from negotiated version")
            write_frame(proc.stdin, {"v": version, "type": "welcome", "host_id": self.policy["route_id"],
                                     "accepted_version": version, "policy": {"max_turn_seconds": self.policy["turn_seconds"]}})
            message_ids = json.loads(row["message_ids"])
            envelope = {"sender_id": row["sender_id"], "channel_id": row["channel_id"],
                        "message_count": len(message_ids)}
            if version == "1.1":
                envelope.update({"source_kind": "agent", "event_kind": "message",
                                 "source_agent_id": row["sender_id"],
                                 "target_agent_id": self.policy["agent_id"],
                                 "project_id": self.policy["project_id"],
                                 "object_ids": message_ids, "correlation_id": wake_id})
            wake = {"v": version, "type": "wake", "wake_id": wake_id,
                    "channel_id": row["channel_id"], "message_ids": message_ids,
                    "envelope": envelope,
                    "generation": self.generation, "epoch": self.epoch}
            # Persist the ambiguity boundary before touching the child stream.
            # A crash from this point cannot prove that the child saw no bytes.
            self._transition(wake_id, "submitted")
            submitted = True
            write_frame(proc.stdin, wake)
            ack = validate_message(self._read_with_timeout(
                proc.stdout, self.policy["handshake_seconds"], receive_buffer, should_stop), {"ack"})
            if ack["v"] != version:
                raise ProtocolError("ack version differs from negotiated version")
            if ack["wake_id"] != wake_id or ack["state"] != "accepted":
                self._transition(wake_id, "error", "runtime_rejected")
                return "error"
            self._transition(wake_id, "running")
            result = validate_message(self._read_with_timeout(
                proc.stdout, self.policy["turn_seconds"], receive_buffer, should_stop), {"result"})
            if result["v"] != version:
                raise ProtocolError("result version differs from negotiated version")
            if result["wake_id"] != wake_id:
                raise ProtocolError("result wake mismatch")
            self._transition(wake_id, result["state"], result.get("summary"))
            return result["state"]
        except (OSError, TimeoutError, EOFError, BrokenPipeError, InterruptedError,
                ProtocolError, KeyError, TypeError, ValueError):
            if submitted:
                self._transition(wake_id, "uncertain", "ambiguous_after_submission")
                return "uncertain"
            return "queued"                 # safe for a later pre-submission retry
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                for stream in (proc.stdin, proc.stdout):
                    if stream is not None:
                        stream.close()

    def recoverable(self):
        return [r[0] for r in self.db.execute(
            "SELECT wake_id FROM wakes WHERE route_id=? AND state='queued' ORDER BY created",
            (self.policy["route_id"],))]

    def status(self):
        return {"route_id": self.policy["route_id"], "generation": self.generation, "epoch": self.epoch,
                "baseline_messages": self.db.execute(
                    "SELECT count(*) FROM baselines WHERE route_id=?",
                    (self.policy["route_id"],)).fetchone()[0],
                "wakes": [dict(r) for r in self.db.execute(
                    "SELECT wake_id,state,channel_id,message_ids,detail FROM wakes ORDER BY created")]}
