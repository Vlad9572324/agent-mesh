"""Offline package-ownership tests; all API boundaries are mocked."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("package_guard_tested", Path(__file__).with_name("package-guard.py"))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
REPOSITORY = {"id": 1234, "full_name": "owner/agent-mesh"}
PACKAGE = {"name": "agent-mesh-server", "package_type": "container", "visibility": "private",
           "repository": REPOSITORY}


class PackageGuardTests(unittest.TestCase):
    def test_package_namespace_is_separate_from_reused_repository_name(self):
        self.assertEqual(guard.registry_repository("Owner/agent-mesh"), "owner/agent-mesh-server")
        for repository in ("owner", "owner/repo/extra", "owner/repo?token=x", "../repo", "owner/../repo"):
            with self.subTest(repository=repository), self.assertRaises(guard.PackageError):
                guard.registry_repository(repository)

    def test_immutable_id_is_mandatory_not_a_boolean_or_name(self):
        self.assertEqual(guard.repository_identity("1234"), 1234)
        for value in (None, True, False, "", "0", "-1", "01", "owner/agent-mesh", "1234\n"):
            with self.subTest(value=value), self.assertRaises(guard.PackageError):
                guard.repository_identity(value)

    def test_existing_private_package_requires_exact_repository_id(self):
        with mock.patch.object(guard, "api_get", side_effect=[(200, REPOSITORY), (200, PACKAGE)]) as api:
            self.assertTrue(guard.check_package("owner/agent-mesh", "1234", "PRIVATE"))
        self.assertEqual([call.args[0] for call in api.call_args_list],
                         ["/repos/owner/agent-mesh", "/users/owner/packages/container/agent-mesh-server"])

    def test_renamed_replaced_or_redirected_source_stops_before_package_lookup(self):
        for status, repository in ((200, {"id": 9999, "full_name": "owner/agent-mesh"}),
                                   (200, {"id": 1234, "full_name": "owner/archive"}),
                                   (301, REPOSITORY), (404, {}), (403, {})):
            with self.subTest(status=status, repository=repository), \
                    mock.patch.object(guard, "api_get", return_value=(status, repository)) as api:
                with self.assertRaisesRegex(guard.PackageError, "immutable identity"):
                    guard.check_package("owner/agent-mesh", "1234", "PRIVATE", allow_missing=True)
                self.assertEqual(api.call_count, 1)

    def test_same_url_different_repository_id_never_adopts_legacy_package(self):
        for package in (dict(PACKAGE, repository={"id": 9999, "full_name": "owner/agent-mesh"}),
                        dict(PACKAGE, repository={"id": 1234, "full_name": "owner/archive"}),
                        dict(PACKAGE, visibility="public"), dict(PACKAGE, name="agent-mesh"),
                        dict(PACKAGE, repository=None)):
            with self.subTest(package=package), mock.patch.object(guard, "api_get", side_effect=[
                    (200, REPOSITORY), (200, package)]):
                with self.assertRaisesRegex(guard.PackageError, "immutable repository ID"):
                    guard.check_package("owner/agent-mesh", "1234", "PRIVATE", allow_missing=True)

    def test_missing_package_is_allowed_only_before_push_and_after_identity_check(self):
        for allow_missing in (False, True):
            with mock.patch.object(guard, "api_get", side_effect=[(200, REPOSITORY), (404, {})]):
                if allow_missing:
                    self.assertFalse(guard.check_package("owner/agent-mesh", "1234", "PRIVATE", allow_missing=True))
                else:
                    with self.assertRaises(guard.PackageError):
                        guard.check_package("owner/agent-mesh", "1234", "PRIVATE")
        for status in (301, 401, 403, 429, 500):
            with self.subTest(status=status), mock.patch.object(guard, "api_get", side_effect=[
                    (200, REPOSITORY), (status, {})]):
                with self.assertRaises(guard.PackageError):
                    guard.check_package("owner/agent-mesh", "1234", "PRIVATE", allow_missing=True)

    def test_cli_context_mismatch_fails_without_api_and_without_secret_output(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "owner/agent-mesh", "GITHUB_REPOSITORY_ID": "9999",
                                         "GITHUB_TOKEN": "PRIVATE_TOKEN"}, clear=True), \
                mock.patch.object(guard, "api_get") as api, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(guard.main(["--repository", "owner/agent-mesh", "--repository-id", "1234"]), 1)
        api.assert_not_called()
        self.assertNotIn("PRIVATE", out.getvalue() + err.getvalue())

    def test_api_guard_rejects_legacy_namespace_before_any_request(self):
        with mock.patch.object(guard.urllib.request, "build_opener") as opener:
            with self.assertRaises(guard.PackageError):
                guard.api_get("/users/owner/packages/container/agent-mesh", "PRIVATE")
        opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
