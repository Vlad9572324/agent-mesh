"""Offline tests for release event, version, source, and live-response fences."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("release_guard", Path(__file__).with_name("release-guard.py"))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
SHA = "a" * 40
OTHER = "b" * 40
REPO = "owner/agent-mesh"
VERSION = "v0.2.0-rc.2"


class Versions(unittest.TestCase):
    def test_valid_versions(self):
        for value in ("v0.1.0", "v1.2.3-rc.1", "v10.20.30-alpha-beta.0", "v1.0.0-AZ.0a"):
            self.assertEqual(guard.validate_version(value), value)

    def test_invalid_versions(self):
        for value in ("1.2.3", "v01.2.3", "v1.2.3-01", "v1.2.3-rc.01", "v1.2.3+meta",
                      "v1.2.3-", "v1.2.3-rc..1", "v1.2.3-rc--x", "v1.2.3-x.-y",
                      "v1.2.3/x", "v1.2.3\n", "v1.2.3;id", None,
                      "v1.2.3-" + "a" * 60):
            with self.subTest(value=value), self.assertRaises(guard.GuardError):
                guard.validate_version(value)

    def test_repository_path_fence(self):
        self.assertEqual(guard.validate_repository(REPO), REPO)
        for value in ("../repo", "owner/..", "owner/repo/extra", "owner/repo?x", "https://github.com/a/b"):
            with self.assertRaises(guard.GuardError):
                guard.validate_repository(value)


class Remote(unittest.TestCase):
    def reference(self, oid=SHA, kind="commit"):
        return {"ref": "refs/tags/" + VERSION, "object": {"sha": oid, "type": kind}}

    def comparison(self, status="ahead"):
        return {"status": status, "base_commit": {"sha": SHA}, "merge_base_commit": {"sha": SHA}}

    def test_lightweight_tag_and_main_ancestry(self):
        with mock.patch.object(guard, "api_get", side_effect=[self.reference(), self.comparison()]) as api:
            guard.check_live(REPO, VERSION, SHA, "PRIVATE")
        self.assertEqual(api.call_count, 2)
        self.assertTrue(api.call_args_list[1].args[1].endswith("...main?per_page=1"))

    def test_annotated_tag_is_peeled(self):
        values = [self.reference(OTHER, "tag"), {"sha": OTHER, "object": {"sha": SHA, "type": "commit"}}, self.comparison("identical")]
        with mock.patch.object(guard, "api_get", side_effect=values):
            guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_moved_tag_is_rejected(self):
        with mock.patch.object(guard, "api_get", return_value=self.reference(OTHER)), self.assertRaises(guard.GuardError):
            guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_wrong_reference_name_is_rejected(self):
        value = self.reference()
        value["ref"] = "refs/tags/v9.9.9"
        with mock.patch.object(guard, "api_get", return_value=value), self.assertRaises(guard.GuardError):
            guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_diverged_or_rewritten_main_is_rejected(self):
        for comparison in (self.comparison("diverged"), self.comparison("behind"),
                           dict(self.comparison(), merge_base_commit={"sha": OTHER})):
            with mock.patch.object(guard, "api_get", side_effect=[self.reference(), comparison]), self.assertRaises(guard.GuardError):
                guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_unbounded_tag_chain_is_rejected(self):
        values = [self.reference(OTHER, "tag")] + [{"sha": OTHER, "object": {"sha": OTHER, "type": "tag"}}] * 8
        with mock.patch.object(guard, "api_get", side_effect=values), self.assertRaises(guard.GuardError):
            guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_malformed_comparison_fails_with_static_guard_error(self):
        for value in (dict(self.comparison(), status=[]), dict(self.comparison(), base_commit=None),
                      dict(self.comparison(), merge_base_commit="PRIVATE")):
            with mock.patch.object(guard, "api_get", side_effect=[self.reference(), value]), self.assertRaises(guard.GuardError):
                guard.check_live(REPO, VERSION, SHA, "PRIVATE")

    def test_invalid_api_targets_and_missing_token_do_not_connect(self):
        for suffix, token in (("/issues", "PRIVATE"), ("/git/ref/tags/" + VERSION, "")):
            with mock.patch.object(guard.urllib.request, "build_opener") as opener, self.assertRaises(guard.GuardError):
                guard.api_get(REPO, suffix, token)
            opener.assert_not_called()


class Local(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git("init", "--initial-branch=main")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.git("update-ref", "refs/remotes/origin/main", self.sha)
        self.git("tag", VERSION)
        self.env = {"GITHUB_REPOSITORY": REPO, "GITHUB_SHA": self.sha,
                    "GITHUB_EVENT_NAME": "push", "GITHUB_REF": "refs/tags/" + VERSION}

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, check=True, text=True)
        return result.stdout

    def check(self, mode="tag"):
        return guard.check_local(self.repo, VERSION, self.sha, mode, REPO, self.env)

    def test_exact_tag_push(self):
        self.assertEqual(self.check(), {"version": VERSION, "source_commit": self.sha,
                                       "prerelease": True, "dry_run": False})

    def test_manual_main_rehearsal_is_not_publication(self):
        self.env.update(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/main")
        self.assertTrue(self.check("dry-run")["dry_run"])
        with self.assertRaises(guard.GuardError):
            self.check("tag")

    def test_wrong_events_refs_or_identity_fail(self):
        for key, value in (("GITHUB_REF", "refs/heads/main"), ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_REPOSITORY", "other/repo"), ("GITHUB_SHA", OTHER)):
            with self.subTest(key=key), mock.patch.dict(self.env, {key: value}), self.assertRaises(guard.GuardError):
                self.check()

    def test_dirty_worktree_fails(self):
        (self.repo / "untracked").write_text("fixture")
        with self.assertRaises(guard.GuardError):
            self.check()

    def test_missing_tag_fails(self):
        self.git("tag", "-d", VERSION)
        with self.assertRaises(guard.GuardError):
            self.check()

    def test_source_outside_main_history_fails(self):
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "outside main")
        self.sha = self.git("rev-parse", "HEAD").strip()
        self.env["GITHUB_SHA"] = self.sha
        with self.assertRaises(guard.GuardError):
            self.check()


if __name__ == "__main__":
    unittest.main()
