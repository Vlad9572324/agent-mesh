#!/usr/bin/env python3
"""Read-only guards for the fresh repository's isolated, public GHCR package."""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

PACKAGE_NAME = "agent-mesh-server"
EXPECTED_VISIBILITY = "public"
API_VERSION = "2026-03-10"


class PackageError(ValueError):
    """Static diagnostics only; never include credentials or remote bodies."""


def require(condition, message):
    if not condition:
        raise PackageError(message)


def registry_repository(repository):
    require(isinstance(repository, str) and
            re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository),
            "GitHub owner/repository required")
    return repository.split("/")[0].lower() + "/" + PACKAGE_NAME


def repository_identity(value):
    require(type(value) in (str, int) and re.fullmatch(r"[1-9][0-9]{0,19}", str(value)),
            "immutable positive GitHub repository ID required")
    return int(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def api_get(path, token):
    require(isinstance(token, str) and token and not re.search(r"[\x00-\x20\x7f]", token),
            "ephemeral workflow token required")
    require(re.fullmatch(r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", path) or
            re.fullmatch(r"/users/[A-Za-z0-9_.-]+/packages/container/" + PACKAGE_NAME, path),
            "unexpected package inspection API path")
    request = urllib.request.Request("https://api.github.com" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": API_VERSION, "User-Agent": "agent-mesh-package-guard"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(1024 * 1024 + 1)
            require(len(raw) <= 1024 * 1024, "package inspection response too large")
            value = json.loads(raw)
            require(isinstance(value, dict), "package inspection response shape mismatch")
            return response.status, value
    except PackageError:
        raise
    except (OSError, ValueError, urllib.error.URLError):
        raise PackageError("package inspection request failed") from None


def verify_repository(repository, identity, token):
    registry_repository(repository)
    identity = repository_identity(identity)
    status, value = api_get("/repos/" + repository, token)
    require(status == 200 and type(value.get("id")) is int and value["id"] == identity and
            value.get("full_name", "").lower() == repository.lower(),
            "live repository immutable identity mismatch")
    return identity


def check_package(repository, identity, token, *, allow_missing=False):
    identity = verify_repository(repository, identity, token)
    owner = repository.split("/")[0]
    status, value = api_get("/users/" + owner + "/packages/container/" + PACKAGE_NAME, token)
    if status == 404 and allow_missing:
        # A hidden/inaccessible package can also return 404. This is not proof
        # of registry tag absence; the authenticated manifest gate is separate.
        return False
    require(status == 200, "package visibility inspection failed")
    linked = value.get("repository") or {}
    require(value.get("name") == PACKAGE_NAME and value.get("visibility") == EXPECTED_VISIBILITY and
            value.get("package_type") == "container" and type(linked.get("id")) is int and
            linked["id"] == identity and linked.get("full_name", "").lower() == repository.lower(),
            "public package associated with this immutable repository ID required")
    return True


def inspect_package(repository, identity, token):
    """Diagnostic metadata only; never accepts or repairs a package for publishing."""
    identity = verify_repository(repository, identity, token)
    owner = repository.split("/")[0]
    status, value = api_get("/users/" + owner + "/packages/container/" + PACKAGE_NAME, token)
    require(status == 200, "package metadata inspection failed")
    linked = value.get("repository")
    linked = linked if isinstance(linked, dict) else {}
    def number(value):
        return value if type(value) is int and 0 < value < 10**20 else None
    def text(value, pattern):
        return value if isinstance(value, str) and len(value) <= 256 and re.fullmatch(pattern, value) else None
    return {"expected_repository_id": identity, "id": number(value.get("id")),
            "name": text(value.get("name"), r"[A-Za-z0-9][A-Za-z0-9_.-]*"),
            "package_type": value.get("package_type") if value.get("package_type") in
                ("container", "docker", "npm", "maven", "rubygems", "nuget") else None,
            "visibility": value.get("visibility") if value.get("visibility") in
                ("private", "public", "internal") else None,
            "repository": {"id": number(linked.get("id")),
                "full_name": text(linked.get("full_name"), r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*")}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--repository-id", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--allow-missing", action="store_true")
    mode.add_argument("--inspect", action="store_true", help="Print allowlisted metadata only; not a publication check")
    args = parser.parse_args(argv)
    try:
        require(os.environ.get("GITHUB_REPOSITORY") == args.repository and
                os.environ.get("GITHUB_REPOSITORY_ID") == args.repository_id,
                "workflow repository identity mismatch")
        if args.inspect:
            print(json.dumps(inspect_package(args.repository, args.repository_id,
                                             os.environ.get("GITHUB_TOKEN", "")), sort_keys=True))
            return 0
        verified = check_package(args.repository, args.repository_id, os.environ.get("GITHUB_TOKEN", ""),
                                 allow_missing=args.allow_missing)
        print(json.dumps({"package": PACKAGE_NAME, "repository_id": int(args.repository_id),
                          "repository_identity_verified": True,
                          "expected_package_visibility": EXPECTED_VISIBILITY,
                          "package_visibility_verified": verified}, sort_keys=True))
        return 0
    except Exception as error:
        print(str(error) if isinstance(error, PackageError) else "package guard failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
