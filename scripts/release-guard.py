#!/usr/bin/env python3
"""Read-only source and event fences for a tagged release or manual rehearsal."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request


VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
MAX_RESPONSE = 2 * 1024 * 1024


class GuardError(ValueError):
    """A static, safe-to-display precondition failure."""


def require(condition, message):
    if not condition:
        raise GuardError(message)


def validate_version(value):
    require(isinstance(value, str) and len(value) <= 64, "bounded release version required")
    match = VERSION.fullmatch(value)
    require(match is not None, "v-prefixed SemVer without build metadata required")
    # Keep the public builder's established conservative lexical subset. A tag
    # accepted here must not be rejected later while creating its archives.
    require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?", value),
            "version is outside the supported archive naming subset")
    for part in (match.group(4) or "").split("."):
        require(not (part.isdigit() and len(part) > 1 and part.startswith("0")),
                "numeric prerelease identifiers must not have leading zeros")
    return value


def validate_repository(value):
    require(isinstance(value, str) and re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", value) is not None
        and value.split("/")[1] not in {".", ".."}, "GitHub owner/repository required")
    return value


def validate_commit(value):
    require(isinstance(value, str) and COMMIT.fullmatch(value) is not None,
            "full source commit required")
    return value


def git(repo, *args, allow_nonzero=False):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
                            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=20, check=False)
    require(allow_nonzero or result.returncode == 0, "local source inspection failed")
    return result


def check_local(repo, version, commit, mode, repository, environment=None):
    validate_version(version)
    validate_commit(commit)
    validate_repository(repository)
    require(mode in {"tag", "dry-run"}, "explicit release mode required")
    env = os.environ if environment is None else environment
    require(env.get("GITHUB_REPOSITORY") == repository and env.get("GITHUB_SHA") == commit,
            "workflow repository or source identity mismatch")
    event, ref = env.get("GITHUB_EVENT_NAME"), env.get("GITHUB_REF")
    if mode == "tag":
        require(event == "push" and ref == "refs/tags/" + version,
                "publication requires the exact version tag push")
    else:
        require(event == "workflow_dispatch" and ref == "refs/heads/main",
                "rehearsal requires a manual main workflow dispatch")
    require(git(repo, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip() == commit,
            "checkout does not match reviewed source")
    require(not git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all",
                    "--ignore-submodules=none").stdout, "release checkout must be clean")
    require(git(repo, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main",
                allow_nonzero=True).returncode == 0, "source commit is not in main history")
    if mode == "tag":
        require(git(repo, "rev-parse", "--verify", "refs/tags/" + version + "^{commit}")
                .stdout.decode().strip() == commit, "local version tag points to a different commit")
    return {"version": version, "source_commit": commit,
            "prerelease": "-" in version, "dry_run": mode == "dry-run"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_get(repository, suffix, token):
    """Only read this repository on api.github.com; never forward credentials."""
    validate_repository(repository)
    require(isinstance(token, str) and bool(token) and "\n" not in token and "\r" not in token,
            "job-scoped GitHub token required")
    allowed = (re.fullmatch(r"/git/ref/tags/v[0-9A-Za-z.-]+", suffix)
               or re.fullmatch(r"/git/tags/[0-9a-f]{40}", suffix)
               or re.fullmatch(r"/compare/[0-9a-f]{40}\.\.\.main\?per_page=1", suffix))
    require(allowed, "unexpected source-verification API path")
    request = urllib.request.Request("https://api.github.com/repos/" + repository + suffix,
        headers={"Accept": "application/vnd.github+json", "Authorization": "Bearer " + token,
                 "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "agent-mesh-release-guard"})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            require(response.status == 200, "source-verification API request failed")
            raw = response.read(MAX_RESPONSE + 1)
        require(len(raw) <= MAX_RESPONSE, "source-verification API response too large")
        result = json.loads(raw)
        require(isinstance(result, dict), "source-verification API shape mismatch")
        return result
    except GuardError:
        raise
    except (OSError, ValueError, urllib.error.URLError):
        raise GuardError("source-verification API request failed") from None


def check_live(repository, version, commit, token):
    """Recheck live tag and main ancestry before publication side effects."""
    validate_repository(repository)
    validate_version(version)
    validate_commit(commit)
    reference = api_get(repository, "/git/ref/tags/" + version, token)
    require(reference.get("ref") == "refs/tags/" + version, "remote tag identity mismatch")
    obj = reference.get("object", {})
    for _ in range(8):
        require(isinstance(obj, dict), "remote tag object shape mismatch")
        oid, kind = obj.get("sha"), obj.get("type")
        validate_commit(oid)
        if kind == "commit":
            require(oid == commit, "remote tag was moved or targets a different source")
            break
        require(kind == "tag", "remote tag must resolve to a commit")
        annotated = api_get(repository, "/git/tags/" + oid, token)
        require(annotated.get("sha") == oid, "annotated tag identity mismatch")
        obj = annotated.get("object", {})
    else:
        raise GuardError("remote annotated tag chain is too deep")
    comparison = api_get(repository, "/compare/" + commit + "...main?per_page=1", token)
    require(comparison.get("status") in ("ahead", "identical")
            and isinstance(comparison.get("base_commit"), dict)
            and isinstance(comparison.get("merge_base_commit"), dict)
            and comparison.get("base_commit", {}).get("sha") == commit
            and comparison.get("merge_base_commit", {}).get("sha") == commit,
            "source commit is no longer in remote main history")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--mode", choices=("tag", "dry-run"), required=True)
    parser.add_argument("--github-repository", required=True)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--live", action="store_true", help="also read current remote tag and main ancestry")
    args = parser.parse_args(argv)
    try:
        require(not args.live or args.mode == "tag", "live tag checks require tag mode")
        result = check_local(args.repository, args.version, args.expected_commit, args.mode,
                             args.github_repository)
        if args.live:
            check_live(args.github_repository, args.version, args.expected_commit, os.environ.get("GITHUB_TOKEN", ""))
    except GuardError as error:
        print("Release source check refused: " + str(error), file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError):
        print("Release source check failed", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
