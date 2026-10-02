"""Offline unit tests: no CLI, credentials, database, or network access."""

import json
import unittest

from handoff_protocol import eligible_message, validate_model_output


RUN = "example-run-1"
ARTIFACT = "sha256:" + "a" * 64
PHASES = ("request_review", "review_result", "acknowledge_review")


def output(phase="request_review", **changes):
    value = {
        "phase": phase,
        "run_id": RUN,
        "artifact_id": ARTIFACT,
        "summary": "Проверено локально.",
        "recipient": "example-writer" if phase == "review_result" else "example-reviewer",
    }
    if phase != "request_review":
        value["verdict"] = "approved"
    if phase == "review_result":
        value["findings"] = []
    value.update(changes)
    return value


def message(phase="request_review", **changes):
    value = {
        "id": "message-1",
        "seq": 1,
        "channel_id": "example-coordination",
        "author_id": "example-reviewer" if phase == "review_result" else "example-writer",
        "recipient_ids": ["example-writer" if phase == "review_result" else "example-reviewer"],
        "reply_to": None if phase == "request_review" else "parent-1",
        "body": json.dumps(output(phase), ensure_ascii=False),
        "created_at": "2026-09-30T00:00:00Z",
    }
    value.update(changes)
    return value


class ModelOutputTests(unittest.TestCase):
    def validate(self, value, phase="request_review"):
        return validate_model_output(json.dumps(value, ensure_ascii=False), phase, RUN, ARTIFACT)

    def test_all_phases_and_verdicts(self):
        for phase in PHASES:
            for verdict in ("approved", "changes_requested"):
                value = output(phase)
                if phase != "request_review":
                    value["verdict"] = verdict
                if phase == "review_result":
                    value["findings"] = ["Один конкретный вывод."]
                with self.subTest(phase=phase, verdict=verdict):
                    self.assertEqual(self.validate(value, phase), value)

    def test_exact_fields(self):
        for phase in PHASES:
            for field in output(phase):
                value = output(phase)
                del value[field]
                with self.subTest(phase=phase, missing=field), self.assertRaises(ValueError):
                    self.validate(value, phase)
            with self.subTest(phase=phase, extra=True), self.assertRaises(ValueError):
                self.validate(output(phase, unexpected=True), phase)
        with self.assertRaises(ValueError):
            self.validate(output(verdict="approved"))
        with self.assertRaises(ValueError):
            self.validate(output("acknowledge_review", findings=[]), "acknowledge_review")

    def test_identity_phase_and_recipient_mismatches(self):
        for field, wrong in (("phase", "review_result"), ("run_id", "other-run"),
                             ("artifact_id", "sha256:" + "b" * 64), ("recipient", "owner")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.validate(output(**{field: wrong}))

    def test_invalid_common_types_and_blank_strings(self):
        for field in ("phase", "run_id", "artifact_id", "recipient", "summary"):
            for wrong in (None, True, 1, [], {}, "", " \n\t"):
                with self.subTest(field=field, wrong=wrong), self.assertRaises(ValueError):
                    self.validate(output(**{field: wrong}))

    def test_summary_character_limit_and_no_normalization(self):
        for summary in ("я" * 2_000, "  summary  "):
            self.assertEqual(self.validate(output(summary=summary))["summary"], summary)
        with self.assertRaises(ValueError):
            self.validate(output(summary="x" * 2_001))

    def test_invalid_verdicts(self):
        for phase in ("review_result", "acknowledge_review"):
            for wrong in (None, True, 1, [], {}, "", "Approved", "rejected"):
                with self.subTest(phase=phase, wrong=wrong), self.assertRaises(ValueError):
                    self.validate(output(phase, verdict=wrong), phase)

    def test_findings_bounds_and_types(self):
        for findings in ([], ["x"] * 10, ["я" * 1_000]):
            self.assertEqual(self.validate(output("review_result", findings=findings),
                                           "review_result")["findings"], findings)
        for wrong in (None, True, 1, "finding", {}, ["x"] * 11, [""], [" "],
                      [None], [1], [True], [[]], [{}], ["x" * 1_001]):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                self.validate(output("review_result", findings=wrong), "review_result")

    def test_raw_json_rejections(self):
        valid = json.dumps(output())
        for raw in (None, valid.encode(), {}, "", "null", "[]", "true", '"text"',
                    "```json\n" + valid + "\n```", valid + valid, "prefix " + valid,
                    valid[:-1] + ',"summary":"duplicate"}',
                    valid.replace('"summary":', '"summary":NaN,"ignored":'),
                    "[" * 2_000 + "]" * 2_000):
            with self.subTest(raw_type=type(raw).__name__), self.assertRaises(ValueError):
                validate_model_output(raw, "request_review", RUN, ARTIFACT)

    def test_code_fences_and_invalid_unicode_inside_fields(self):
        for summary in ("```example```", "\ud800"):
            with self.subTest(summary=ascii(summary)), self.assertRaises(ValueError):
                validate_model_output(json.dumps(output(summary=summary)),
                                      "request_review", RUN, ARTIFACT)
        with self.assertRaises(ValueError):
            validate_model_output("\ud800", "request_review", RUN, ARTIFACT)

    def test_entire_utf8_byte_limit(self):
        raw = json.dumps(output(), ensure_ascii=False)
        remaining = 10_000 - len(raw.encode("utf-8"))
        self.assertEqual(validate_model_output(raw + " " * remaining, "request_review", RUN, ARTIFACT),
                         output())
        with self.assertRaises(ValueError):
            validate_model_output(raw + " " * (remaining + 1), "request_review", RUN, ARTIFACT)
        # The characters fit under 10k, but their UTF-8 representation does not.
        raw = json.dumps(output("review_result", findings=["я" * 1_000] * 5), ensure_ascii=False)
        self.assertLess(len(raw), 10_000)
        with self.assertRaises(ValueError):
            validate_model_output(raw, "review_result", RUN, ARTIFACT)

    def test_invalid_expected_context(self):
        raw = json.dumps(output())
        for phase, run, artifact in (("unknown", RUN, ARTIFACT), ([], RUN, ARTIFACT),
                                     (None, RUN, ARTIFACT), ("request_review", "", ARTIFACT),
                                     ("request_review", RUN, None)):
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                validate_model_output(raw, phase, run, artifact)

    def test_errors_do_not_echo_input(self):
        with self.assertRaises(ValueError) as caught:
            validate_model_output("PRIVATE-MODEL-TEXT", "request_review", RUN, ARTIFACT)
        self.assertNotIn("PRIVATE-MODEL-TEXT", str(caught.exception))


class EligibleMessageTests(unittest.TestCase):
    def eligible(self, value, phase="request_review", **changes):
        context = {"phase": phase, "run_id": RUN, "artifact_id": ARTIFACT,
                   "parent_id": None if phase == "request_review" else "parent-1"}
        context.update(changes)
        return eligible_message(value, **context)

    def test_positive_all_phases_and_envelope_extensions(self):
        for phase in PHASES:
            with self.subTest(phase=phase):
                self.assertTrue(self.eligible(message(phase), phase))

    def test_invalid_author_channel_and_recipients(self):
        for phase in PHASES:
            for changes in ({"author_id": "owner"}, {"author_id": "example-outsider"},
                            {"channel_id": "other"}, {"recipient_ids": []},
                            {"recipient_ids": ["owner"]}, {"recipient_ids": None},
                            {"recipient_ids": "example-reviewer"},
                            {"recipient_ids": message(phase)["recipient_ids"] * 2},
                            {"recipient_ids": message(phase)["recipient_ids"] + ["owner"]}):
                with self.subTest(phase=phase, changes=changes):
                    self.assertFalse(self.eligible(message(phase, **changes), phase))

    def test_exact_parent_and_no_missing_parent_field(self):
        for phase in PHASES:
            self.assertFalse(self.eligible(message(phase, reply_to="other-parent"), phase))
            value = message(phase)
            del value["reply_to"]
            self.assertFalse(self.eligible(value, phase))
        self.assertFalse(self.eligible(message(reply_to="parent-1"), parent_id="parent-1"))
        for phase in PHASES[1:]:
            self.assertFalse(self.eligible(message(phase, reply_to=None), phase, parent_id=None))
            self.assertFalse(self.eligible(message(phase, reply_to=""), phase, parent_id=""))

    def test_invalid_message_id_and_sequence(self):
        for identifier in (None, True, 1, [], {}, "", " ", "\ud800"):
            with self.subTest(identifier=ascii(identifier)):
                self.assertFalse(self.eligible(message(id=identifier)))
        for sequence in (None, True, False, 0, -1, 1.0, "1", [], {}):
            with self.subTest(sequence=sequence):
                self.assertFalse(self.eligible(message(seq=sequence)))

    def test_missing_envelope_fields_and_wrong_envelope_type(self):
        for field in message():
            if field == "created_at":
                continue
            value = message()
            del value[field]
            with self.subTest(missing=field):
                self.assertFalse(self.eligible(value))
        for value in (None, [], "message", True):
            self.assertFalse(self.eligible(value))

    def test_body_wrong_run_digest_phase_extra_and_types(self):
        for changes in ({"run_id": "other-run"}, {"artifact_id": "sha256:" + "b" * 64},
                        {"phase": "acknowledge_review"}, {"extra": True},
                        {"recipient": "example-writer"}, {"summary": []}):
            self.assertFalse(self.eligible(message(body=json.dumps(output(**changes)))))
        for body in (None, {}, "not JSON", " " * 10_001):
            self.assertFalse(self.eligible(message(body=body)))

    def test_invalid_expected_context_fails_closed(self):
        for changes in ({"phase": "unknown"}, {"phase": []}, {"run_id": None},
                        {"artifact_id": "wrong-digest"}, {"parent_id": True}):
            with self.subTest(changes=changes):
                self.assertFalse(self.eligible(message(), **changes))


if __name__ == "__main__":
    unittest.main()
