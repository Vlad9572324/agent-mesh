#!/usr/bin/env python3
"""Publish a verified tag release from GitHub Actions, with no overwrite/resume.

The draft is published only after four uploaded assets and a same-version GHCR
image have been remotely verified. Failure leaves a draft for human inspection;
this program never deletes assets, moves tags, or changes package visibility.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load_module("release_archive_verifier", "smoke-release.py")
package_guard = load_module("release_package_guard", "package-guard.py")
MAX_BODY = 128 * 1024 * 1024
API_VERSION = "2026-03-10"


class PublishError(Exception):
    """Static non-sensitive failure reason."""


def require(condition, message):
    if not condition:
        raise PublishError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def request(method, url, *, headers=None, data=None, limit=MAX_BODY):
    # Redirects are explicit so an API Authorization header cannot reach storage.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    call = urllib.request.Request(url, headers=headers or {}, data=data, method=method)
    try:
        response = opener.open(call, timeout=120)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(limit + 1)
        require(len(raw) <= limit, "HTTP response size boundary")
        return response.status, dict(response.headers), raw


def safe_download_url(value):
    parsed = urllib.parse.urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname in {
        "release-assets.githubusercontent.com", "objects.githubusercontent.com"} and
        parsed.port in (None, 443) and not parsed.username and not parsed.password and not parsed.fragment,
        "unexpected release asset redirect")
    return value


def registry_missing(status, raw):
    if status != 404:
        return False
    try:
        value = release.strict_json(raw)
        errors = value.get("errors")
        return isinstance(errors, list) and bool(errors) and all(
            isinstance(item, dict) and item.get("code") in {"MANIFEST_UNKNOWN", "NAME_UNKNOWN"}
            for item in errors)
    except Exception:
        return False


def verify_inputs(directory, version, commit):
    names = ("agent-mesh_" + version + "_linux_amd64.tar.gz",
             "agent-mesh_" + version + "_connectors.tar.gz", "RELEASE.json", "SHA256SUMS")
    require(set(path.name for path in directory.iterdir()) == set(names), "exactly four release assets required")
    assets = release.verify_inputs(directory / names[0], directory / names[1], directory / names[3])
    assets["SHA256SUMS"] = release.read_regular(directory / "SHA256SUMS", 16384)
    metadata = release.validate_metadata(assets["RELEASE.json"], version)
    require(metadata["source_commit"] == commit and metadata["builder_version"] == "go1.23.6",
            "release source or toolchain mismatch")
    with tempfile.TemporaryDirectory(prefix="agent-mesh-publish-inputs-") as temporary:
        for name, kind in ((names[0], "server"), (names[1], "connectors")):
            root, actual = release.extract_archive(assets[name], name, kind, Path(temporary))
            require(actual == version and release.read_regular(root / "RELEASE.json", 65536) == assets["RELEASE.json"],
                    "archive metadata mismatch")
    return metadata, assets


class Publisher:
    def __init__(self, args, directory, token, guard):
        self.args, self.token, self.guard = args, token, guard
        self.base = "/repos/" + args.repository
        self.image_repository = package_guard.registry_repository(args.repository)
        self.repository_id = package_guard.repository_identity(args.repository_id)
        self.directory = directory
        self.env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(directory), "LANG": "C.UTF-8"}
        self.config = directory / "docker-config"
        self.config.mkdir(mode=0o700)
        self.docker = ["docker", "--host", "unix:///var/run/docker.sock", "--config", str(self.config)]
        self.report = {"success": False, "version": args.version, "source_commit": args.expected_commit,
                       "repository_id": self.repository_id, "image_repository": self.image_repository,
                       "phase": "inputs", "draft_created": False, "assets_verified": 0,
                       "digest_pull_verified": False, "package_visibility_verified": False,
                       "expected_package_visibility": package_guard.EXPECTED_VISIBILITY,
                       "release_published": False}

    def api(self, method, path, value=None, *, expected=200):
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": API_VERSION}
        raw = None
        if value is not None:
            headers["Content-Type"] = "application/json"
            raw = json.dumps(value).encode()
        status, _, body = request(method, "https://api.github.com" + path, headers=headers, data=raw, limit=8*1024*1024)
        require(status == expected, "GitHub API request failed")
        return release.strict_json(body)

    def command(self, args, *, data=None, timeout=180):
        result = subprocess.run(self.docker + args, cwd=self.directory, env=self.env,
                                input=data, stdin=subprocess.DEVNULL if data is None else None,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        require(result.returncode == 0, "Docker command failed")
        return result.stdout

    def live_source(self):
        package_guard.verify_repository(self.args.repository, self.repository_id, self.token)
        self.guard.check_live(self.args.repository, self.args.version, self.args.expected_commit, self.token)

    def release_absent(self):
        # Unlike the public get-by-tag endpoint, authenticated listing includes
        # drafts for this write-authorized repository token. Never adopt a draft.
        for page in range(1, 101):
            values = self.api("GET", self.base + "/releases?per_page=100&page=" + str(page))
            require(isinstance(values, list), "release listing required")
            require(all(item.get("tag_name") != self.args.version for item in values),
                    "release or draft already exists; operator reconciliation required")
            if len(values) < 100:
                return
        raise PublishError("release listing pagination limit")

    def image_absent(self):
        # Request the same repository scope needed for the impending push. A
        # pull-only lookup may be unauthorized before a package's first creation.
        authorization = base64.b64encode((self.args.repository.split("/")[0] + ":" + self.token).encode()).decode()
        query = urllib.parse.urlencode({"service": "ghcr.io", "scope": "repository:" + self.image_repository + ":pull,push"})
        status, _, raw = request("GET", "https://ghcr.io/token?" + query,
                                 headers={"Authorization": "Basic " + authorization}, limit=65536)
        require(status == 200, "registry authentication failed")
        value = release.strict_json(raw)
        token = value.get("token") or value.get("access_token")
        require(isinstance(token, str) and 0 < len(token) <= 32768, "registry bearer token required")
        path = "https://ghcr.io/v2/" + self.image_repository + "/manifests/" + self.args.version
        status, _, raw = request("GET", path, headers={"Authorization": "Bearer " + token,
            "Accept": "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"}, limit=1024*1024)
        require(registry_missing(status, raw), "registry did not prove version tag absence")

    def check_package(self, *, allow_missing=False):
        self.report["package_visibility_verified"] = package_guard.check_package(
            self.args.repository, self.repository_id, self.token, allow_missing=allow_missing)

    def create_draft(self):
        self.report["phase"] = "draft"
        self.live_source()
        self.release_absent()
        draft = self.api("POST", self.base + "/releases", {
            "tag_name": self.args.version, "target_commitish": self.args.expected_commit,
            "name": "Agent Mesh " + self.args.version, "draft": True,
            "prerelease": "-" in self.args.version, "make_latest": "false",
            "generate_release_notes": False,
            "body": "Source commit: `" + self.args.expected_commit + "`.\n\n"
                    "Linux amd64 server and matching web assets, plus Python connectors.\n\n"
                    "Container: `" + self.args.image + "`. SHA256SUMS covers both archives and RELEASE.json."}, expected=201)
        require(type(draft.get("id")) is int and draft["id"] > 0 and draft.get("draft") is True and
                draft.get("tag_name") == self.args.version, "created draft identity mismatch")
        self.release_id = draft["id"]
        self.report.update(draft_created=True, release_id=self.release_id)

    def validate_asset(self, asset, name, data):
        require(type(asset.get("id")) is int and asset["id"] > 0 and asset.get("name") == name and
                asset.get("state") == "uploaded" and asset.get("size") == len(data) and
                asset.get("digest") == "sha256:" + hashlib.sha256(data).hexdigest(), "uploaded asset identity mismatch")

    def download_asset(self, asset_id):
        url = "https://api.github.com" + self.base + "/releases/assets/" + str(asset_id)
        status, headers, raw = request("GET", url, headers={"Authorization": "Bearer " + self.token,
                                        "Accept": "application/octet-stream", "X-GitHub-Api-Version": API_VERSION})
        if status == 302:
            location = next((value for key, value in headers.items() if key.lower() == "location"), "")
            # No token, cookies or Authorization header accompanies this request.
            status, _, raw = request("GET", safe_download_url(location), headers={})
        require(status == 200, "release asset download failed")
        return raw

    def upload_and_verify(self, assets):
        self.report["phase"] = "assets"
        ids = set()
        for name, data in sorted(assets.items()):
            url = "https://uploads.github.com" + self.base + "/releases/" + str(self.release_id) + "/assets?" + urllib.parse.urlencode({"name": name})
            status, _, raw = request("POST", url, headers={"Authorization": "Bearer " + self.token,
                    "Accept": "application/vnd.github+json", "Content-Type": "application/octet-stream",
                    "X-GitHub-Api-Version": API_VERSION}, data=data, limit=65536)
            require(status == 201, "release asset upload failed")
            asset = release.strict_json(raw)
            self.validate_asset(asset, name, data)
            require(asset["id"] not in ids, "duplicate asset identity")
            ids.add(asset["id"])
            require(self.download_asset(asset["id"]) == data, "downloaded release asset mismatch")
            self.report["assets_verified"] += 1
        listed = self.api("GET", self.base + "/releases/" + str(self.release_id) + "/assets?per_page=100")
        require(isinstance(listed, list) and len(listed) == 4 and {item["id"] for item in listed} == ids,
                "remote canonical asset set mismatch")
        self.assets, self.asset_ids = assets, ids

    def publish_image(self, metadata):
        self.report["phase"] = "image"
        self.live_source()
        self.check_package(allow_missing=True)
        self.image_absent()  # Recheck immediately before push; no moving aliases.
        self.command(["login", "ghcr.io", "--username", self.args.repository.split("/")[0], "--password-stdin"],
                     data=self.token.encode())
        self.command(["push", self.args.image])
        info = release.strict_json(self.command(["image", "inspect", self.args.image]))[0]
        prefix = "ghcr.io/" + self.image_repository + "@sha256:"
        digests = [value for value in info.get("RepoDigests", []) if value.startswith(prefix) and
                   re.fullmatch(r"[0-9a-f]{64}", value[len(prefix):])]
        require(len(digests) == 1, "published digest required")
        digest = digests[0]
        self.command(["pull", digest])
        actual = release.strict_json(self.command(["run", "--rm", "--network", "none", digest, "--version"]))
        require(actual == {"version": self.args.version, "commit": self.args.expected_commit,
                "build_date": metadata["build_date"], "go_version": "go1.23.6", "goos": "linux", "goarch": "amd64"},
                "published image version mismatch")
        self.report.update(digest=digest, digest_pull_verified=True)
        self.check_package()

    def publish_draft(self):
        self.report["phase"] = "publish"
        self.live_source()
        path = self.base + "/releases/" + str(self.release_id)
        draft = self.api("GET", path)
        require(draft.get("draft") is True and draft.get("tag_name") == self.args.version and
                draft.get("id") == self.release_id and
                draft.get("prerelease") is ("-" in self.args.version),
                "draft changed before publication")
        assets = draft.get("assets")
        require(isinstance(assets, list) and len(assets) == 4 and
                {item.get("id") for item in assets} == self.asset_ids and
                {item.get("name") for item in assets} == set(self.assets), "draft assets changed before publication")
        for asset in assets:
            self.validate_asset(asset, asset["name"], self.assets[asset["name"]])
        self.check_package()
        self.live_source()
        body = ("Source commit: `" + self.args.expected_commit + "`.\n\n"
                "Linux amd64 server with matching web assets, plus Python connectors. "
                "Both archives were validated on a hosted runner; Compose HTTPS, PostgreSQL 14, "
                "owner authentication, database recovery and cleanup passed.\n\n"
                "Container version: `" + self.args.image + "`.\n\n"
                "Verified immutable image digest: `" + self.report["digest"] + "`.\n\n"
                "Download SHA256SUMS and the three referenced assets, then run `sha256sum -c SHA256SUMS`. "
                "The server binary and its three web assets must stay together. "
                "These checks verify consistency; obtain all artifacts from this trusted repository.")
        result = self.api("PATCH", path, {"draft": False, "make_latest": "false" if "-" in self.args.version else "legacy",
                                          "body": body})
        require(result.get("draft") is False and result.get("tag_name") == self.args.version and
                result.get("id") == self.release_id, "published release identity mismatch")
        self.report.update(release_published=True, success=True, phase="complete")

    def run(self):
        metadata, assets = verify_inputs(self.args.release_dir, self.args.version, self.args.expected_commit)
        self.report["asset_sha256"] = {name: hashlib.sha256(data).hexdigest() for name, data in assets.items()}
        self.live_source()
        self.release_absent()
        self.image_absent()
        self.check_package(allow_missing=True)
        self.create_draft()
        self.upload_and_verify(assets)
        self.publish_image(metadata)
        self.publish_draft()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--repository-id", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--evidence-out", required=True, type=Path)
    args = parser.parse_args(argv)
    publisher = None
    report = {"success": False, "phase": "preconditions"}
    try:
        guard = load_module("release_source_guard", "release-guard.py")
        guard.validate_version(args.version)
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository) and
                re.fullmatch(r"[0-9a-f]{40}", args.expected_commit), "repository and source commit required")
        require(args.image == "ghcr.io/" + package_guard.registry_repository(args.repository) + ":" + args.version,
                "same-version isolated-package image required")
        require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "push" and
                os.environ.get("GITHUB_REF") == "refs/tags/" + args.version and
                os.environ.get("GITHUB_REPOSITORY") == args.repository and
                os.environ.get("GITHUB_REPOSITORY_ID") == args.repository_id and
                os.environ.get("GITHUB_SHA") == args.expected_commit, "verified tag-push workflow required")
        guard.check_local(Path(__file__).resolve().parents[1], args.version, args.expected_commit,
                          "tag", args.repository)
        token = os.environ.get("GITHUB_TOKEN", "")
        require(bool(token), "ephemeral workflow token required")
        require(not args.evidence_out.exists() and not args.evidence_out.is_symlink(), "new evidence path required")
        with tempfile.TemporaryDirectory(prefix="agent-mesh-publish-") as temporary:
            publisher = Publisher(args, Path(temporary), token, guard)
            report = publisher.report
            publisher.run()
    except Exception as error:
        report["failure"] = str(error) if isinstance(error, (PublishError, package_guard.PackageError)) else "publication failed"
    print(json.dumps(report, sort_keys=True))
    # Only allowlisted public metadata/counters are written; no token/log dump.
    try:
        with args.evidence_out.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, sort_keys=True)
            stream.write("\n")
    except OSError:
        return 1
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
