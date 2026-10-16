"""AMRP/1 bounded JSONL codec and message validation.

The stream is protocol-only stdout/stdin.  A frame is one UTF-8 JSON object
terminated by LF.  The hard byte limit is enforced before JSON decoding so an
untrusted peer cannot make the receiver buffer an unbounded line.
"""

import json
import re


MAX_FRAME_BYTES = 64 * 1024
SUPPORTED_VERSIONS = ("1.1", "1.0")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_CAP = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ProtocolError(ValueError):
    """The peer sent an invalid or unsupported AMRP frame."""


def _reject_constant(value):
    raise ProtocolError("non-finite JSON number is forbidden: " + value)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate JSON key: " + key)
        result[key] = value
    return result


def _identifier(value, field):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ProtocolError(field + " is not a valid identifier")


def _exact_keys(value, required, optional=()):
    keys = set(value)
    missing = set(required) - keys
    extra = keys - set(required) - set(optional)
    if missing:
        raise ProtocolError("missing fields: " + ", ".join(sorted(missing)))
    if extra:
        raise ProtocolError("unexpected fields: " + ", ".join(sorted(extra)))


def _version(value, field="v"):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*\.[0-9]+", value):
        raise ProtocolError(field + " is not a protocol version")


def _string(value, field, max_length=1024, allow_empty=False):
    if not isinstance(value, str) or len(value) > max_length or (not allow_empty and not value):
        raise ProtocolError(field + " is not a bounded string")


def _string_list(value, field, validator, limit=256, allow_empty=False):
    if (not isinstance(value, list) or len(value) > limit
            or (not allow_empty and not value)):
        raise ProtocolError(field + " must be a bounded list")
    seen = []
    for item in value:
        validator(item, field)
        if item in seen:
            raise ProtocolError(field + " contains duplicates")
        seen.append(item)


def _capability(value, field):
    if not isinstance(value, str) or not _CAP.fullmatch(value):
        raise ProtocolError(field + " contains an invalid capability")


def _positive_int(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ProtocolError(field + " must be a positive integer")


def _validate_envelope(value, version, wake):
    if not isinstance(value, dict):
        raise ProtocolError("envelope must be an object")
    # Deliberately structured and closed: peer text, commands and arguments
    # have nowhere to enter the local execution control plane.
    legacy = ("sender_id", "channel_id", "message_count")
    typed = ("source_kind", "event_kind", "source_agent_id", "target_agent_id",
             "project_id", "object_ids", "correlation_id")
    _exact_keys(value, legacy + (typed if version == "1.1" else ()))
    _identifier(value["sender_id"], "envelope.sender_id")
    _identifier(value["channel_id"], "envelope.channel_id")
    _positive_int(value["message_count"], "envelope.message_count")
    if version == "1.1":
        if value["source_kind"] != "agent" or value["event_kind"] != "message":
            raise ProtocolError("wake envelope has an unsupported source or event kind")
        for field in ("source_agent_id", "target_agent_id", "project_id", "correlation_id"):
            _identifier(value[field], "envelope." + field)
        _string_list(value["object_ids"], "envelope.object_ids", _identifier)
        if value["source_agent_id"] != value["sender_id"]:
            raise ProtocolError("wake envelope source does not match sender")
        if value["object_ids"] != wake["message_ids"]:
            raise ProtocolError("wake envelope objects do not match message_ids")
        if value["correlation_id"] != wake["wake_id"]:
            raise ProtocolError("wake envelope correlation does not match wake")


def validate_message(message, expected_types=None):
    """Validate and return an AMRP message without mutating it.

    Schemas are closed.  In particular, wake frames cannot carry a message
    body, executable, command, arguments, environment or provider session id.
    """
    if not isinstance(message, dict):
        raise ProtocolError("frame must be a JSON object")
    kind = message.get("type")
    if expected_types is not None and kind not in set(expected_types):
        raise ProtocolError("unexpected message type")
    if kind == "hello":
        _exact_keys(message, ("type", "v", "agent_id", "caps", "runtime", "proto"))
        _version(message["v"])
        _identifier(message["agent_id"], "agent_id")
        _string_list(message["caps"], "caps", _capability, limit=64, allow_empty=True)
        _identifier(message["runtime"], "runtime")
        _string_list(message["proto"], "proto", _version, limit=16)
    elif kind == "welcome":
        _exact_keys(message, ("type", "v", "accepted_version", "host_id", "policy"))
        _version(message["v"])
        _version(message["accepted_version"], "accepted_version")
        _identifier(message["host_id"], "host_id")
        if not isinstance(message["policy"], dict):
            raise ProtocolError("policy must be an object")
        # AMRP/1 has no remotely supplied launch policy knobs.
        _exact_keys(message["policy"], (), ("max_turn_seconds",))
        if "max_turn_seconds" in message["policy"]:
            _positive_int(message["policy"]["max_turn_seconds"], "policy.max_turn_seconds")
    elif kind == "wake":
        _exact_keys(message, ("type", "v", "wake_id", "channel_id", "message_ids", "envelope"),
                    ("epoch", "generation", "resume_hint"))
        _version(message["v"])
        _identifier(message["wake_id"], "wake_id")
        _identifier(message["channel_id"], "channel_id")
        _string_list(message["message_ids"], "message_ids", _identifier)
        _validate_envelope(message["envelope"], message["v"], message)
        if message["envelope"]["channel_id"] != message["channel_id"]:
            raise ProtocolError("envelope channel does not match wake")
        if message["envelope"]["message_count"] != len(message["message_ids"]):
            raise ProtocolError("envelope count does not match message_ids")
        for field in ("epoch", "generation"):
            if field in message:
                _positive_int(message[field], field)
        if "resume_hint" in message:
            _identifier(message["resume_hint"], "resume_hint")
    elif kind == "ack":
        _exact_keys(message, ("type", "v", "wake_id", "state"), ("reason",))
        _version(message["v"])
        _identifier(message["wake_id"], "wake_id")
        if message["state"] not in ("accepted", "rejected"):
            raise ProtocolError("invalid ack state")
        if "reason" in message:
            _string(message["reason"], "reason", 512)
    elif kind == "result":
        _exact_keys(message, ("type", "v", "wake_id", "state"), ("summary",))
        _version(message["v"])
        _identifier(message["wake_id"], "wake_id")
        if message["state"] not in ("done", "error", "cancelled", "uncertain"):
            raise ProtocolError("invalid result state")
        if "summary" in message:
            _string(message["summary"], "summary", 4096, allow_empty=True)
    elif kind == "cancel":
        _exact_keys(message, ("type", "v", "wake_id"))
        _version(message["v"])
        _identifier(message["wake_id"], "wake_id")
    elif kind == "heartbeat":
        _exact_keys(message, ("type", "v"), ("runtime",))
        _version(message["v"])
        if "runtime" in message:
            _identifier(message["runtime"], "runtime")
    else:
        raise ProtocolError("unknown message type")
    return message


def negotiate_version(peer_versions, supported=SUPPORTED_VERSIONS):
    """Select the highest mutually supported major/minor version."""
    if not isinstance(peer_versions, (list, tuple)) or not peer_versions:
        raise ProtocolError("peer supplied no protocol versions")
    for value in tuple(peer_versions) + tuple(supported):
        _version(value, "protocol version")
    common = set(peer_versions).intersection(supported)
    if not common:
        raise ProtocolError("no mutually supported protocol version")
    return max(common, key=lambda value: tuple(int(x) for x in value.split(".")))


def decode_frame(line):
    """Decode one complete bounded JSONL frame (bytes, including LF)."""
    if not isinstance(line, (bytes, bytearray)):
        raise ProtocolError("frame must be bytes")
    line = bytes(line)
    if len(line) > MAX_FRAME_BYTES:
        raise ProtocolError("frame exceeds byte limit")
    if not line.endswith(b"\n") or line.count(b"\n") != 1:
        raise ProtocolError("frame must contain exactly one terminating LF")
    if b"\r" in line:
        raise ProtocolError("CR is forbidden in JSONL framing")
    try:
        text = line[:-1].decode("utf-8", errors="strict")
        value = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except ProtocolError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ProtocolError("invalid JSON frame") from exc
    return validate_message(value)


def encode_frame(message):
    """Validate and encode one canonical compact JSONL frame."""
    validate_message(message)
    try:
        payload = json.dumps(message, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":")).encode("utf-8") + b"\n"
    except (TypeError, ValueError) as exc:
        raise ProtocolError("message is not finite JSON") from exc
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError("frame exceeds byte limit")
    return payload


def read_frame(stream):
    """Read one frame from a binary stream; return None only at clean EOF."""
    line = stream.readline(MAX_FRAME_BYTES + 1)
    if line == b"":
        return None
    if len(line) > MAX_FRAME_BYTES:
        raise ProtocolError("frame exceeds byte limit")
    return decode_frame(line)


def write_frame(stream, message):
    stream.write(encode_frame(message))
    stream.flush()
