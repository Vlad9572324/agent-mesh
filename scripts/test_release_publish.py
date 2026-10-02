"""Offline publication guards: all HTTP, registry, and Docker boundaries mocked."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("release_publish", Path(__file__).with_name("release-publish.py"))
publish = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish)
VERSION, COMMIT = "v0.2.0-rc.1", "a" * 40


def asset_record(name, data, identity=1):
    return {"id": identity, "name": name, "state": "uploaded", "size": len(data),
            "digest": "sha256:" + hashlib.sha256(data).hexdigest()}


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.args = argparse.Namespace(version=VERSION, expected_commit=COMMIT, repository="owner/repo",
                    repository_id="1234", image="ghcr.io/owner/agent-mesh-server:" + VERSION,
                    release_dir=self.directory / "release")
        self.guard = mock.Mock()
        self.instance = publish.Publisher(self.args, self.directory, "PRIVATE_TOKEN", self.guard)

    def test_registry_absence_is_strictly_404_and_known_error_code(self):
        known = b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'
        self.assertTrue(publish.registry_missing(404, known))
        self.assertTrue(publish.registry_missing(404, b'{"errors":[{"code":"NAME_UNKNOWN"}]}'))
        for status, raw in ((200, known), (401, known), (403, known), (500, known),
                            (404, b""), (404, b'{}'), (404, b'{"errors":[]}'),
                            (404, b'{"errors":[{"code":"DENIED"}]}')):
            with self.subTest(status=status, raw=raw):
                self.assertFalse(publish.registry_missing(status, raw))

    def test_redirect_url_allowlist_rejects_credentials_and_wrong_origin(self):
        publish.safe_download_url("https://release-assets.githubusercontent.com/owned?signature=PRIVATE")
        for url in ("http://release-assets.githubusercontent.com/x", "https://evil.example/x",
                    "https://release-assets.githubusercontent.com.evil.example/x",
                    "https://user:PRIVATE@objects.githubusercontent.com/x", "https://objects.githubusercontent.com:444/x"):
            with self.subTest(url=url), self.assertRaises(publish.PublishError):
                publish.safe_download_url(url)

    def test_asset_redirect_never_receives_api_token(self):
        with mock.patch.object(publish, "request", side_effect=[
                (302, {"Location": "https://release-assets.githubusercontent.com/owned"}, b""),
                (200, {}, b"asset")]) as request:
            self.assertEqual(self.instance.download_asset(123), b"asset")
        self.assertIn("Authorization", request.call_args_list[0].kwargs["headers"])
        self.assertEqual(request.call_args_list[1].kwargs["headers"], {})

    def test_asset_download_supports_direct_response(self):
        with mock.patch.object(publish, "request", return_value=(200, {}, b"asset")):
            self.assertEqual(self.instance.download_asset(123), b"asset")

    def test_existing_draft_or_release_blocks_without_writes(self):
        for draft in (False, True):
            with mock.patch.object(self.instance, "api", return_value=[{"tag_name": VERSION, "draft": draft}]) as api:
                with self.assertRaisesRegex(publish.PublishError, "already exists"):
                    self.instance.release_absent()
            self.assertEqual(api.call_args.args[0], "GET")

    def test_release_absence_follows_pages(self):
        page = [{"tag_name": "v0.0.1"}] * 100
        with mock.patch.object(self.instance, "api", side_effect=[page, []]) as api:
            self.instance.release_absent()
        self.assertEqual(api.call_count, 2)
        self.assertIn("page=2", api.call_args.args[1])

    def test_registry_probe_uses_authenticated_pull_push_but_only_get(self):
        with mock.patch.object(publish, "request", side_effect=[(200, {}, b'{"token":"PRIVATE_BEARER"}'),
                (404, {}, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}')]) as request:
            self.instance.image_absent()
        self.assertEqual([call.args[0] for call in request.call_args_list], ["GET", "GET"])
        self.assertIn("pull%2Cpush", request.call_args_list[0].args[1])
        self.assertIn("owner%2Fagent-mesh-server", request.call_args_list[0].args[1])
        self.assertIn("/v2/owner/agent-mesh-server/manifests/", request.call_args_list[1].args[1])
        self.assertEqual(request.call_args_list[1].kwargs["headers"]["Authorization"], "Bearer PRIVATE_BEARER")
        self.assertNotIn("PRIVATE", json.dumps(self.instance.report))

    def test_registry_auth_denial_never_becomes_absence(self):
        with mock.patch.object(publish, "request", return_value=(403, {}, b"PRIVATE")) as request:
            with self.assertRaisesRegex(publish.PublishError, "authentication failed"):
                self.instance.image_absent()
        self.assertEqual(request.call_count, 1)

    def test_existing_private_or_unrelated_package_blocks(self):
        for value in ({"visibility": "private", "package_type": "container", "repository": {"id": 1234, "full_name": "owner/repo"}},
                      {"visibility": "public", "package_type": "container", "repository": {"id": 1234, "full_name": "owner/other"}},
                      {"visibility": "public", "package_type": "container", "repository": {"id": 9999, "full_name": "owner/repo"}}):
            value["name"] = "agent-mesh-server"
            with mock.patch.object(publish.package_guard, "api_get", side_effect=[
                    (200, {"id": 1234, "full_name": "owner/repo"}), (200, value)]):
                with self.assertRaisesRegex(publish.package_guard.PackageError, "immutable repository ID"):
                    self.instance.check_package(allow_missing=True)

    def test_missing_package_allowed_only_before_push(self):
        with mock.patch.object(publish.package_guard, "api_get", side_effect=[
                (200, {"id": 1234, "full_name": "owner/repo"}), (404, {}),
                (200, {"id": 1234, "full_name": "owner/repo"}), (404, {})]):
            self.instance.check_package(allow_missing=True)
            with self.assertRaises(publish.package_guard.PackageError):
                self.instance.check_package()
        self.assertFalse(self.instance.report["package_visibility_verified"])
        self.assertEqual(self.instance.report["expected_package_visibility"], "public")

    def test_public_package_report_does_not_claim_private_verification(self):
        value = {"name": "agent-mesh-server", "visibility": "public", "package_type": "container",
                 "repository": {"id": 1234, "full_name": "owner/repo"}}
        with mock.patch.object(publish.package_guard, "api_get", side_effect=[
                (200, {"id": 1234, "full_name": "owner/repo"}), (200, value)]):
            self.instance.check_package()
        self.assertTrue(self.instance.report["package_visibility_verified"])
        self.assertEqual(self.instance.report["expected_package_visibility"], "public")
        self.assertNotIn("package_private_verified", self.instance.report)

    def test_create_draft_never_creates_published_release_or_latest(self):
        with mock.patch.object(self.instance, "live_source") as live, \
             mock.patch.object(self.instance, "release_absent") as absent, \
             mock.patch.object(self.instance, "api", return_value={"id": 7, "draft": True, "tag_name": VERSION}) as api:
            self.instance.create_draft()
        live.assert_called_once()
        absent.assert_called_once()
        body = api.call_args.args[2]
        self.assertTrue(body["draft"])
        self.assertTrue(body["prerelease"])
        self.assertEqual(body["target_commitish"], COMMIT)
        self.assertEqual(body["make_latest"], "false")
        self.assertTrue(self.instance.report["draft_created"])

    def test_asset_metadata_checks_name_state_size_digest(self):
        data = b"asset"
        valid = asset_record("SHA256SUMS", data)
        self.instance.validate_asset(valid, "SHA256SUMS", data)
        for field, value in (("id", 0), ("name", "other"), ("state", "starter"), ("size", 0), ("digest", "sha256:wrong")):
            with self.subTest(field=field), self.assertRaises(publish.PublishError):
                self.instance.validate_asset(dict(valid, **{field: value}), "SHA256SUMS", data)

    def test_upload_requires_remote_bytes_and_exact_asset_set(self):
        self.instance.release_id = 7
        assets = {name: name.encode() for name in ("server", "connectors", "RELEASE.json", "SHA256SUMS")}
        records = [asset_record(name, data, index) for index, (name, data) in enumerate(sorted(assets.items()), 1)]
        with mock.patch.object(publish, "request", side_effect=[(201, {}, json.dumps(item).encode()) for item in records]), \
             mock.patch.object(self.instance, "download_asset", side_effect=[assets[item["name"]] for item in records]), \
             mock.patch.object(self.instance, "api", return_value=records):
            self.instance.upload_and_verify(assets)
        self.assertEqual(self.instance.report["assets_verified"], 4)
        self.assertEqual(self.instance.asset_ids, {1, 2, 3, 4})

    def test_download_mutation_fails_before_image_publication(self):
        self.instance.release_id = 7
        record = asset_record("asset", b"good")
        with mock.patch.object(publish, "request", return_value=(201, {}, json.dumps(record).encode())), \
             mock.patch.object(self.instance, "download_asset", return_value=b"wrong"):
            with self.assertRaisesRegex(publish.PublishError, "downloaded release asset mismatch"):
                self.instance.upload_and_verify({"asset": b"good"})

    def test_publication_order_and_failure_leave_draft_unpublished(self):
        names = ("live_source", "release_absent", "image_absent", "check_package", "create_draft",
                 "upload_and_verify", "publish_image", "publish_draft")
        events = []
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(publish, "verify_inputs", return_value=({}, {"asset": b"data"})))
            for name in names:
                stack.enter_context(mock.patch.object(self.instance, name, side_effect=lambda *a, name=name, **k: events.append(name)))
            self.instance.run()
        self.assertEqual(events, list(names))
        with mock.patch.object(publish, "verify_inputs", return_value=({}, {})), \
             mock.patch.object(self.instance, "live_source"), mock.patch.object(self.instance, "release_absent"), \
             mock.patch.object(self.instance, "image_absent"), mock.patch.object(self.instance, "check_package"), \
             mock.patch.object(self.instance, "create_draft"), \
             mock.patch.object(self.instance, "upload_and_verify", side_effect=publish.PublishError("upload failed")), \
             mock.patch.object(self.instance, "publish_image") as image, \
             mock.patch.object(self.instance, "publish_draft") as final:
            with self.assertRaises(publish.PublishError):
                self.instance.run()
        image.assert_not_called()
        final.assert_not_called()

    def test_changed_draft_asset_blocks_final_patch(self):
        self.instance.release_id = 7
        self.instance.assets = {str(index): b"data" for index in range(4)}
        records = [asset_record(name, data, index) for index, (name, data) in enumerate(self.instance.assets.items(), 1)]
        self.instance.asset_ids = {1, 2, 3, 4}
        records[0]["digest"] = "sha256:changed"
        draft = {"id": 7, "draft": True, "tag_name": VERSION, "prerelease": True, "assets": records}
        with mock.patch.object(self.instance, "live_source"), \
             mock.patch.object(self.instance, "api", return_value=draft) as api:
            with self.assertRaises(publish.PublishError):
                self.instance.publish_draft()
        self.assertEqual([call.args[0] for call in api.call_args_list], ["GET"])

    def test_final_publication_prerelease_and_stable_latest_policy(self):
        self.instance.release_id = 7
        self.instance.assets = {str(index): b"data" for index in range(4)}
        records = [asset_record(name, data, index) for index, (name, data) in enumerate(self.instance.assets.items(), 1)]
        self.instance.asset_ids = {1, 2, 3, 4}
        self.instance.report["digest"] = "ghcr.io/owner/agent-mesh-server@sha256:" + "b" * 64
        for version, latest in ((VERSION, "false"), ("v0.2.0", "legacy")):
            self.args.version = version
            draft = {"id": 7, "draft": True, "tag_name": version, "prerelease": "-" in version, "assets": records}
            with mock.patch.object(self.instance, "live_source") as live, \
                 mock.patch.object(self.instance, "check_package") as package, \
                 mock.patch.object(self.instance, "api", side_effect=[draft, {"id": 7, "draft": False,
                     "tag_name": version}]) as api:
                self.instance.publish_draft()
            body = api.call_args.args[2]
            self.assertFalse(body["draft"])
            self.assertEqual(body["make_latest"], latest)
            self.assertIn(self.instance.report["digest"], body["body"])
            self.assertIn(COMMIT, body["body"])
            self.assertIn("sha256sum -c SHA256SUMS", body["body"])
            self.assertEqual(live.call_count, 2)
            package.assert_called_once()

    def test_source_fence_precedes_all_mutations(self):
        with mock.patch.object(self.instance, "live_source", side_effect=ValueError("PRIVATE")), \
             mock.patch.object(self.instance, "api") as api:
            with self.assertRaises(ValueError):
                self.instance.create_draft()
        api.assert_not_called()

    def test_live_source_requires_immutable_repository_id_before_tag_lookup(self):
        with mock.patch.object(publish.package_guard, "verify_repository",
                               side_effect=publish.package_guard.PackageError("live repository immutable identity mismatch")):
            with self.assertRaises(publish.package_guard.PackageError):
                self.instance.live_source()
        self.guard.check_live.assert_not_called()

    def test_legacy_package_name_cannot_reach_publication(self):
        evidence = self.directory / "legacy-refusal.json"
        with mock.patch.object(publish.Publisher, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            status = publish.main(["--release-dir", str(self.directory), "--repository", "owner/repo",
                "--repository-id", "1234", "--version", VERSION, "--expected-commit", COMMIT,
                "--image", "ghcr.io/owner/repo:" + VERSION, "--evidence-out", str(evidence)])
        self.assertEqual(status, 1)
        run.assert_not_called()
        self.assertIn("isolated-package", json.loads(evidence.read_text())["failure"])

    def test_docker_children_do_not_inherit_workflow_credentials(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "PRIVATE", "DOCKER_HOST": "tcp://PRIVATE"}), \
             mock.patch.object(publish.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=b"")) as run:
            self.instance.command(["login", "ghcr.io", "--password-stdin"], data=b"PRIVATE")
        self.assertNotIn("GITHUB_TOKEN", run.call_args.kwargs["env"])
        self.assertNotIn("DOCKER_HOST", run.call_args.kwargs["env"])
        self.assertNotIn("PRIVATE", " ".join(run.call_args.args[0]))
        self.assertEqual(run.call_args.kwargs["input"], b"PRIVATE")

    def test_uploaded_asset_set_is_checked_again_before_publication(self):
        self.instance.release_id = 7
        self.instance.assets = {str(index): b"data" for index in range(4)}
        self.instance.asset_ids = {1, 2, 3, 4}
        draft = {"id": 7, "draft": True, "tag_name": VERSION, "prerelease": True, "assets": []}
        with mock.patch.object(self.instance, "live_source"), \
             mock.patch.object(self.instance, "api", return_value=draft) as api:
            with self.assertRaisesRegex(publish.PublishError, "draft assets changed"):
                self.instance.publish_draft()
        self.assertEqual(api.call_count, 1)

    def test_manual_dispatch_cannot_call_publisher(self):
        output = io.StringIO()
        evidence = self.directory / "evidence.json"
        with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch"}), \
             mock.patch.object(publish.Publisher, "run") as run, contextlib.redirect_stdout(output):
            status = publish.main(["--release-dir", str(self.directory), "--repository", "owner/repo",
                "--repository-id", "1234",
                "--version", VERSION, "--expected-commit", COMMIT, "--image", self.args.image,
                "--evidence-out", str(evidence)])
        self.assertEqual(status, 1)
        run.assert_not_called()
        self.assertFalse(json.loads(evidence.read_text())["success"])


if __name__ == "__main__":
    unittest.main()
