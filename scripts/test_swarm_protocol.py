"""Offline regression tests; no model CLI, files, keys, or network used."""

import copy
import json
import unittest

from swarm_protocol import ARTIFACT_PATHS, MAX_BYTES, STAGES, eligible, parse_result


RUN = "swarm-fixture-1"
SOURCE = "fixture-author"
RECIPIENTS = ["fixture-reviewer", "fixture-observer"]


def result(review=False, **changes):
    value = {"summary": "Краткий результат.", "findings": [],
             "verdict": "approved" if review else None}
    value.update(changes)
    return value


def body(stage="implementation_ready", **changes):
    review = stage in ("review_result", "acknowledge")
    parents = ["implementation-message", "tests-message"] if stage == "review_result" else ["verdict-message"] if stage == "acknowledge" else []
    value = {**result(review), "run_id": RUN, "stage": stage,
             "artifacts": {path: "a" * 64 for path in ARTIFACT_PATHS}, "related_ids": parents}
    value.update(changes)
    return value


def message(stage="implementation_ready", **changes):
    data = body(stage)
    value = {"id": "server-message", "seq": 1, "channel_id": "example-coordination",
             "author_id": SOURCE, "recipient_ids": RECIPIENTS.copy(),
             "reply_to": data["related_ids"][0] if data["related_ids"] else None,
             "body": json.dumps(data, ensure_ascii=False), "created_at": "server extension"}
    value.update(changes)
    return value


class ResultTests(unittest.TestCase):
    def test_valid_results_are_preserved(self):
        for review, verdict in ((False, None), (True, "approved"), (True, "changes_requested")):
            data = result(review, verdict=verdict, summary="  Точно как получено  ", findings=["Вывод"])
            self.assertEqual(parse_result(json.dumps(data), review=review), data)

    def test_exact_fields(self):
        for missing in result():
            data = result()
            del data[missing]
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                parse_result(json.dumps(data))
        with self.assertRaises(ValueError):
            parse_result(json.dumps(result(extra=True)))

    def test_text_and_finding_limits(self):
        parse_result(json.dumps(result(summary="x" * 2500, findings=["x" * 1200])))
        parse_result(json.dumps(result(findings=["x"] * 12)))
        invalid = [result(summary=x) for x in (None, True, 1, "", " \n", "x" * 2501, "\ud800")]
        invalid += [result(findings=x) for x in (None, {}, "text", ["x"] * 13, [""], [" "], [None], [1], ["x" * 1201], ["\ud800"])]
        for data in invalid:
            with self.subTest(data=repr(data)[:60]), self.assertRaises(ValueError):
                parse_result(json.dumps(data))

    def test_verdict_types(self):
        for review, wrong in ((False, "approved"), (False, False), (True, None),
                              (True, True), (True, []), (True, "Approved"), (True, "rejected")):
            with self.subTest(review=review, wrong=wrong), self.assertRaises(ValueError):
                parse_result(json.dumps(result(verdict=wrong)), review=review)
        with self.assertRaises(ValueError):
            parse_result(json.dumps(result()), review=1)

    def test_strict_json(self):
        raw = json.dumps(result())
        bad = [None, {}, raw.encode(), "", "null", "[]", "true", raw + raw,
               raw[:-1] + ',"summary":"duplicate"}', raw.replace("null", "NaN"),
               raw.replace("null", "Infinity"), "```json\n" + raw + "\n```",
               json.dumps(result(summary="```hidden fence```")), "\ud800",
               "[" * 2000 + "]" * 2000]
        bad.append(json.dumps(result(summary="```encoded```")).replace("`", "\\u0060"))
        for value in bad:
            with self.subTest(kind=type(value).__name__), self.assertRaises(ValueError):
                parse_result(value)

    def test_entire_utf8_byte_bound(self):
        raw = json.dumps(result(), ensure_ascii=False)
        padding = MAX_BYTES - len(raw.encode())
        self.assertEqual(parse_result(raw + " " * padding), result())
        with self.assertRaises(ValueError):
            parse_result(raw + " " * (padding + 1))
        with self.assertRaises(ValueError):
            parse_result(json.dumps(result(findings=["я" * 1200] * 6), ensure_ascii=False))

    def test_error_never_echoes_private_input(self):
        with self.assertRaises(ValueError) as caught:
            parse_result("PRIVATE-SENTINEL")
        self.assertNotIn("PRIVATE-SENTINEL", str(caught.exception))


class EnvelopeTests(unittest.TestCase):
    def check(self, value, stage="implementation_ready", **context):
        expected = {"run_id": RUN, "stage": stage, "source": SOURCE, "recipients": RECIPIENTS}
        expected.update(context)
        return eligible(value, **expected)

    def test_all_correct_stages_and_exact_parent_context(self):
        for stage in STAGES:
            with self.subTest(stage=stage):
                value = message(stage)
                before = copy.deepcopy(value)
                self.assertTrue(self.check(value, stage))
                self.assertTrue(self.check(value, stage, related_ids=body(stage)["related_ids"]))
                self.assertEqual(value, before)

    def test_caller_controls_roles_not_a_hidden_fixed_role_map(self):
        self.assertTrue(self.check(message(author_id="another", recipient_ids=[]), source="another", recipients=[]))

    def test_required_server_fields_and_metadata(self):
        for field in ("id", "seq", "channel_id", "author_id", "recipient_ids", "reply_to", "body"):
            value = message()
            del value[field]
            with self.subTest(missing=field):
                self.assertFalse(self.check(value))
        for changes in ({"id": " "}, {"id": "\ud800"}, {"seq": True}, {"seq": 0}, {"seq": -1},
                        {"seq": 1.0}, {"channel_id": "other"}, {"author_id": "other"},
                        {"recipient_ids": RECIPIENTS[::-1]}, {"recipient_ids": RECIPIENTS + ["extra"]},
                        {"recipient_ids": None}, {"recipient_ids": []}, {"reply_to": "wrong"}):
            with self.subTest(changes=changes):
                self.assertFalse(self.check(message(**changes)))

    def test_exact_body_fields_and_identity(self):
        for field in body():
            data = body()
            del data[field]
            with self.subTest(missing=field):
                self.assertFalse(self.check(message(body=json.dumps(data))))
        for changes in ({"extra": True}, {"run_id": "other"}, {"stage": "tests_ready"},
                        {"verdict": "approved"}, {"findings": [""]}, {"summary": "x" * 2501}):
            self.assertFalse(self.check(message(body=json.dumps(body(**changes)))))
        self.assertFalse(self.check(message(body=json.dumps(body())[:-1] + ',"summary":"duplicate"}')))

    def test_parent_phase_gates(self):
        for stage in STAGES:
            self.assertFalse(self.check(message(stage, reply_to="wrong"), stage))
            if stage in ("review_result", "acknowledge"):
                self.assertFalse(self.check(message(stage, reply_to=None), stage))
            wrong_lists = [["same", "same"], ["a", "b", "c"], [None], [True], [" "], "parent"]
            wrong_lists += [[]] if stage in ("review_result", "acknowledge") else [["parent"]]
            wrong_lists += [["one"]] if stage == "review_result" else [["one", "two"]] if stage == "acknowledge" else []
            for parents in wrong_lists:
                self.assertFalse(self.check(message(stage, body=json.dumps(body(stage, related_ids=parents))), stage))
            self.assertFalse(self.check(message(stage), stage, related_ids=["other-parent"]))

    def test_review_verdicts_and_nonreview_null(self):
        for stage in STAGES:
            values = ("approved", "changes_requested") if stage in ("review_result", "acknowledge") else (None,)
            for verdict in values:
                self.assertTrue(self.check(message(stage, body=json.dumps(body(stage, verdict=verdict))), stage))
            for verdict in (True, [], "rejected"):
                self.assertFalse(self.check(message(stage, body=json.dumps(body(stage, verdict=verdict))), stage))

    def test_artifact_allowlist_hashes_and_duplicate_keys(self):
        for artifacts in ({}, {next(iter(ARTIFACT_PATHS)): "A" * 64}):
            self.assertTrue(self.check(message(body=json.dumps(body(artifacts=artifacts)))))
        path = next(iter(ARTIFACT_PATHS))
        invalid = [None, [], {"../manifest.go": "a" * 64}, {"/manifest.go": "a" * 64},
                   {path: "a" * 63}, {path: "g" * 64}, {path: 123}, {path: "a" * 64 + "\n"},
                   {"unapproved" + str(i): "a" * 64 for i in range(5)}]
        for artifacts in invalid:
            self.assertFalse(self.check(message(body=json.dumps(body(artifacts=artifacts)))))
        raw = json.dumps(body(artifacts={path: "a" * 64}))
        raw = raw.replace(json.dumps(path) + ": " + json.dumps("a" * 64),
                          json.dumps(path) + ':"' + "a" * 64 + '",' + json.dumps(path) + ':"' + "b" * 64 + '"')
        self.assertFalse(self.check(message(body=raw)))

    def test_malformed_context_and_body_fail_closed(self):
        for context in ({"stage": []}, {"stage": "unknown"}, {"run_id": None}, {"source": ""},
                        {"recipients": None}, {"recipients": [None]}, {"recipients": ["x", "x"]},
                        {"related_ids": [None]}, {"related_ids": "parent"}):
            self.assertFalse(self.check(message(), **context))
        for raw in (None, {}, "null", "[]", "\ud800", "[" * 2000 + "]" * 2000,
                    json.dumps(body()).replace("null", "NaN"), " " * (MAX_BYTES + 1)):
            self.assertFalse(self.check(message(body=raw)))
        for value in (None, [], "message", 1):
            self.assertFalse(self.check(value))


if __name__ == "__main__":
    unittest.main()
