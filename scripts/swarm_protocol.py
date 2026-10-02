"""Pure, strict parsing and routing checks for a bounded example review workflow.

No normalization, network, model execution, filesystem access, or credentials.
The caller still owns artifact verification, durable deduplication and dispatch.
The channel and artifact paths are fictional examples, not operator data.
"""

import json
import re


MAX_BYTES = 14_000
RESULT_FIELDS = frozenset(("summary", "findings", "verdict"))
ENVELOPE_FIELDS = RESULT_FIELDS | {"run_id", "stage", "artifacts", "related_ids"}
STAGES = frozenset(("implementation_ready", "tests_ready", "preflight",
                    "review_result", "acknowledge"))
REVIEW_STAGES = frozenset(("review_result", "acknowledge"))
ARTIFACT_PATHS = frozenset((
    "code/example/validate.go",
    "tests/example/validate_test.go",
))
_SHA256 = re.compile(r"[0-9a-fA-F]{64}")


def _text(value, limit=None):
    if type(value) is not str or not value.strip() or "```" in value:
        return False
    if limit is not None and len(value) > limit:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("non-standard JSON constant")


def _parse(raw):
    if type(raw) is not str:
        raise ValueError("JSON text required")
    try:
        if len(raw.encode("utf-8")) > MAX_BYTES or "```" in raw:
            raise ValueError("invalid JSON size or formatting")
        value = json.loads(raw, object_pairs_hook=_unique_object,
                           parse_constant=_constant)
    except (ValueError, RecursionError):
        raise ValueError("invalid bounded JSON object") from None
    if type(value) is not dict:
        raise ValueError("JSON object required")
    return value


def _result_valid(value, review):
    if not _text(value["summary"], 2500):
        return False
    findings = value["findings"]
    if type(findings) is not list or len(findings) > 12:
        return False
    if not all(_text(item, 1200) for item in findings):
        return False
    verdict = value["verdict"]
    return (type(verdict) is str and verdict in ("approved", "changes_requested")) if review else verdict is None


def parse_result(raw, *, review=False):
    """Return the exact model result or raise a generic, non-echoing ValueError."""
    if type(review) is not bool:
        raise ValueError("review must be boolean")
    value = _parse(raw)
    if set(value) != RESULT_FIELDS or not _result_valid(value, review):
        raise ValueError("invalid model result fields")
    return value


def _ids(value, limit=None):
    return (type(value) is list and (limit is None or len(value) <= limit)
            and all(_text(item) for item in value) and len(set(value)) == len(value))


def eligible(message, *, run_id, stage, source, recipients, related_ids=None):
    """Fail closed on malformed messages or routing/phase/context mismatches.

Server envelope extension fields are allowed; body fields must match exactly.
An omitted related_ids context still requires the stage-specific parent shape.
"""
    if (not _text(run_id) or type(stage) is not str or stage not in STAGES
            or not _text(source) or not _ids(recipients)):
        return False
    if related_ids is not None and not _ids(related_ids, 2):
        return False
    required = {"id", "seq", "channel_id", "author_id", "recipient_ids", "reply_to", "body"}
    if type(message) is not dict or not required <= set(message):
        return False
    if (not _text(message["id"]) or type(message["seq"]) is not int or message["seq"] <= 0
            or message["channel_id"] != "example-coordination" or message["author_id"] != source
            or type(message["recipient_ids"]) is not list or message["recipient_ids"] != recipients):
        return False
    try:
        value = _parse(message["body"])
    except ValueError:
        return False
    if (set(value) != ENVELOPE_FIELDS or value["run_id"] != run_id
            or value["stage"] != stage or not _result_valid(value, stage in REVIEW_STAGES)):
        return False
    artifacts = value["artifacts"]
    if (type(artifacts) is not dict or len(artifacts) > 4
            or any(path not in ARTIFACT_PATHS or type(digest) is not str
                   or _SHA256.fullmatch(digest) is None for path, digest in artifacts.items())):
        return False
    parents = value["related_ids"]
    if not _ids(parents, 2) or (related_ids is not None and parents != related_ids):
        return False
    if stage not in REVIEW_STAGES:
        return not parents and message["reply_to"] is None
    count = 2 if stage == "review_result" else 1
    return len(parents) == count and message["reply_to"] == parents[0]
