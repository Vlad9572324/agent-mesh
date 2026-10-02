"""Strict, side-effect-free validation for a three-message review handoff.

These checks establish message shape and routing only. The caller owns durable
deduplication, phase ordering, artifact verification, and the three-message cap.
No model output is normalized or repaired. Validation errors never echo it.
The fixed routing identifiers below are fictional examples, not operator data.
"""

import json


MAX_OUTPUT_BYTES = 10_000
_COMMON_FIELDS = {"phase", "run_id", "artifact_id", "summary", "recipient"}
_PHASES = {
    "request_review": ("example-writer", "example-reviewer", set()),
    "review_result": ("example-reviewer", "example-writer", {"verdict", "findings"}),
    "acknowledge_review": ("example-writer", "example-reviewer", {"verdict"}),
}
_VERDICTS = {"approved", "changes_requested"}


def _text(value, limit=None):
    if type(value) is not str or not value.strip():
        return False
    if limit is not None and len(value) > limit:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("non-standard JSON constant")


def validate_model_output(raw: str, phase: str, run_id: str, artifact_id: str) -> dict:
    """Return the exact validated JSON object; raise ValueError on any mismatch.

The byte cap applies to the entire UTF-8 input, including whitespace. Run and
artifact IDs are opaque nonempty strings and must match the caller's values.
"""
    if type(phase) is not str or phase not in _PHASES:
        raise ValueError("invalid expected phase")
    if not _text(run_id) or not _text(artifact_id):
        raise ValueError("invalid expected identity")
    if type(raw) is not str:
        raise ValueError("output must be a JSON string")
    try:
        size = len(raw.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError("output is not valid UTF-8") from None
    if size > MAX_OUTPUT_BYTES:
        raise ValueError("output exceeds byte limit")
    if "```" in raw:
        raise ValueError("code fences are not permitted")
    try:
        value = json.loads(raw, object_pairs_hook=_object, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise ValueError("invalid JSON object") from None
    author, recipient, additional = _PHASES[phase]
    if type(value) is not dict or set(value) != _COMMON_FIELDS | additional:
        raise ValueError("incorrect fields for phase")
    if type(value["phase"]) is not str or value["phase"] != phase:
        raise ValueError("phase mismatch")
    if not _text(value["run_id"]) or value["run_id"] != run_id:
        raise ValueError("run identity mismatch")
    if not _text(value["artifact_id"]) or value["artifact_id"] != artifact_id:
        raise ValueError("artifact identity mismatch")
    if type(value["recipient"]) is not str or value["recipient"] != recipient:
        raise ValueError("recipient mismatch")
    if not _text(value["summary"], 2_000):
        raise ValueError("invalid summary")
    if "verdict" in additional:
        if type(value["verdict"]) is not str or value["verdict"] not in _VERDICTS:
            raise ValueError("invalid verdict")
    if "findings" in additional:
        findings = value["findings"]
        if type(findings) is not list or len(findings) > 10:
            raise ValueError("invalid findings list")
        if not all(_text(finding, 1_000) for finding in findings):
            raise ValueError("invalid finding")
    return value


def eligible_message(message, *, phase, run_id, artifact_id, parent_id) -> bool:
    """Fail closed on malformed or unrelated server messages.

Envelope extension fields (such as created_at) are allowed. Required routing
fields must be present; the initial request has no parent, and each subsequent
phase must have the exact nonempty parent ID supplied by the caller.
"""
    if type(phase) is not str or phase not in _PHASES:
        return False
    if type(message) is not dict:
        return False
    required = {"id", "seq", "channel_id", "author_id", "recipient_ids", "reply_to", "body"}
    if not required.issubset(message):
        return False
    if not _text(message["id"]) or type(message["seq"]) is not int or message["seq"] <= 0:
        return False
    if phase == "request_review":
        if parent_id is not None:
            return False
    elif not _text(parent_id):
        return False
    author, recipient, _additional = _PHASES[phase]
    if message["channel_id"] != "example-coordination" or message["author_id"] != author:
        return False
    if type(message["recipient_ids"]) is not list or message["recipient_ids"] != [recipient]:
        return False
    if message["reply_to"] != parent_id:
        return False
    try:
        validate_model_output(message["body"], phase, run_id, artifact_id)
    except ValueError:
        return False
    return True
