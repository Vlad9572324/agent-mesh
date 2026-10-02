"""Pure native-activity response validation; no operator state or service access."""
from datetime import datetime
import re


ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
EVENT_TYPES = frozenset(("session.started", "session.ended", "turn.started", "turn.completed",
    "tool.started", "tool.completed", "tool.failed", "agent.waiting", "inbox.offered", "inbox.seen", "inbox.accepted"))
FIELDS = frozenset(("id", "seq", "channel_id", "actor_id", "client_id", "session_id", "runtime",
    "event_type", "tool_name", "message_id", "created_at", "provenance", "server_verified"))
TIMESTAMP = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})\Z")


def require(condition):
    if not condition:
        raise ValueError("check_failed")


def identifier(value):
    return type(value) is str and ID.fullmatch(value) is not None


def timestamp(value):
    require(type(value) is str and len(value) <= 64)
    match = TIMESTAMP.fullmatch(value)
    require(match is not None)
    base, fraction, zone = match.groups()
    # Go emits RFC3339Nano with trailing fractional zeroes removed. Python
    # 3.10 fromisoformat accepts only 3/6 digits, so normalize valid 1..9 digits.
    normalized = base + ('.' + fraction.ljust(6, '0')[:6] if fraction else '')
    normalized += '+00:00' if zone == 'Z' else zone
    require(datetime.fromisoformat(normalized).utcoffset() is not None)


def validate_page(data, channel, after, limit):
    require(type(data) is dict and set(data) == {"activity", "has_more", "next_after_seq"})
    rows = data["activity"]
    require(type(rows) is list and len(rows) <= limit and type(data["has_more"]) is bool)
    require(type(data["next_after_seq"]) is int and data["next_after_seq"] >= after)
    prior, seen = after, set()
    for item in rows:
        require(type(item) is dict and set(item) == FIELDS)
        require(all(identifier(item[name]) for name in ("id", "actor_id", "client_id", "session_id", "channel_id")))
        require(item["channel_id"] == channel and item["id"] not in seen)
        seen.add(item["id"])
        require(type(item["seq"]) is int and prior < item["seq"] <= 2**63 - 1)
        prior = item["seq"]
        require(item["runtime"] in ("codex", "claude") and item["event_type"] in EVENT_TYPES)
        tool, message = item["tool_name"], item["message_id"]
        require(tool is None or (identifier(tool) and item["event_type"].startswith("tool.")))
        require(identifier(message) if item["event_type"].startswith("inbox.") else message is None)
        require(item["provenance"] == "client_reported" and item["server_verified"] is False)
        timestamp(item["created_at"])
    require(data["next_after_seq"] == prior and (not data["has_more"] or len(rows) == limit))
    return seen
