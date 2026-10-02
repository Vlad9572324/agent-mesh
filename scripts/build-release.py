#!/usr/bin/env python3
"""Build the narrowly scoped, reproducible linux/amd64 pilot release offline.

Requires Python 3.10+, Git, Go and already cached Go module dependencies. The
output must be an absolute, nonexistent directory with an existing parent.
Only allowlisted committed blobs are read; ignored credentials/runtime files
are never copied. No deployment, provider invocation, Git mutation or download
is performed. Reproducibility requires the same Go/Python/zlib toolchain.
"""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


PACKAGING_VERSION = 3
TARGET = {"goos": "linux", "goarch": "amd64"}
VERSION = re.compile(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\Z")
INSTALL_SOURCE = "docs/install-release.md"
INSTALL_VERSION_MARKER = re.compile(r"^<!-- release-install-version: (\S+) -->$", re.MULTILINE)
NOTICES_SOURCE = "docs/third-party-notices.md"
LICENSE_FILES = ("LICENSE", "NOTICE")
WEB_FILES = ("web/index.html", "web/app.js", "web/app.css")
CONNECTOR_FILES = (
    "scripts/agent-link-cli.py",
    "scripts/native_launch.py",
    "scripts/agent-link-hook.py",
    "scripts/agent-link-mcp.py",
    "adapters/native_bridge.py",
    "adapters/native_hooks.py",
    "adapters/native_mcp.py",
    "scripts/agent-link-listener.py",
    "adapters/task_listener.py",
    "adapters/coordination.py",
    "scripts/dev_trial_runtimes.py",
    "scripts/artifact_client.py",
    "scripts/agent-link-artifacts.py",
    "docs/task-listener.md",
    "listener-contract.json",
)
ONBOARDING_FILES = (
    "onboarding/install.sh", "onboarding/install.py", "onboarding/connect.py",
    "onboarding/README.md", "onboarding/PROMPT.md",
)
# The server embeds these exact committed connector sources for invitations.
EMBED_FILES = (*CONNECTOR_FILES, *LICENSE_FILES, "CLI-CONNECTION.md", NOTICES_SOURCE,
               *ONBOARDING_FILES)
# Review changes to this list together with Go embeds/imports. Tests and other
# tools are deliberately not build inputs, and never become release payloads.
BUILD_FILES = (
    "onboarding_assets.go",
    "go.mod",
    "go.sum",
    "cmd/agent-link/main.go",
    "cmd/agent-link/onboarding.go",
    "cmd/agent-link/version.go",
    "internal/link/admin.go",
    "internal/link/artifacts.go",
    "internal/link/artifacts_schema.sql",
    "internal/link/http.go",
    "internal/link/lifecycle.go",
    "internal/link/memory.go",
    "internal/link/memory_schema.sql",
    "internal/link/native_events.go",
    "internal/link/native_events_schema.sql",
    "internal/link/navigation.go",
    "internal/link/navigation_schema.sql",
    "internal/link/onboarding.go",
    "internal/link/onboarding_schema.sql",
    "internal/link/project_map.go",
    "internal/link/schema.sql",
    "internal/link/sessions.go",
    "internal/link/sessions_schema.sql",
    "internal/link/store.go",
    "internal/link/tasks.go",
    "internal/link/tasks_schema.sql",
    "internal/link/workspace.go",
)


class ReleaseError(ValueError):
    """An explicit release precondition failed."""


def relative_path(value):
    """Accept only canonical, bounded archive/manifest names, never links."""
    if (not isinstance(value, str) or not value or len(value) > 200
            or not re.fullmatch(r"[A-Za-z0-9_./-]+", value)
            or value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/"))):
        raise ReleaseError("noncanonical relative path")
    return value


def validate_version(value):
    if not isinstance(value, str) or len(value) > 64 or VERSION.fullmatch(value) is None:
        raise ReleaseError("version must be a v-prefixed release version, such as v0.1.0-rc.1")
    return value


def render_install_guide(source, version):
    """Retarget only the guide's explicitly declared example version in memory."""
    validate_version(version)
    try:
        guide = source.decode("utf-8")
    except UnicodeError as error:
        raise ReleaseError("install guide must be UTF-8") from error
    markers = INSTALL_VERSION_MARKER.findall(guide)
    if len(markers) != 1 or guide.count("release-install-version:") != 1:
        raise ReleaseError("install guide requires exactly one canonical release-install-version marker")
    example_version = validate_version(markers[0])
    return guide.replace(example_version, version).encode("utf-8")


def validate_manifest(names):
    result = tuple(names)
    if len(set(result)) != len(result):
        raise ReleaseError("duplicate manifest entry")
    for name in result:
        relative_path(name)
    return result


def validate_output(value):
    output = Path(value)
    if not output.is_absolute() or ".." in output.parts or output == Path(output.anchor):
        raise ReleaseError("output must be an absolute, new directory")
    # Reject both dangling links and symlinked ancestors before creating files.
    for component in (output, *output.parents):
        if component.is_symlink():
            raise ReleaseError("output path must not contain symlinks")
    if output.exists():
        raise ReleaseError("output already exists; refusing to overwrite")
    if not output.parent.is_dir():
        raise ReleaseError("output parent must already be a directory")
    return output


def git(repo, *args):
    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0")
    # Respect the specified repository, not a caller's unrelated Git context.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES"):
        env.pop(key, None)
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise ReleaseError("Git source inspection failed")
    return result.stdout


def clean_commit(repo, expected=None):
    if git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"):
        raise ReleaseError("release requires a clean committed checkout (including untracked files)")
    commit = git(repo, "rev-parse", "--verify", "HEAD^{commit}").decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ReleaseError("release requires a SHA-1 Git source commit")
    if expected is not None and expected != commit:
        raise ReleaseError("source commit changed during the build")
    return commit


def source_tree(repo, commit):
    tree = {}
    for entry in git(repo, "ls-tree", "-rz", "--full-tree", commit).split(b"\0"):
        if not entry:
            continue
        header, name = entry.split(b"\t", 1)
        mode, kind, oid = header.decode("ascii").split()
        tree[name.decode("utf-8")] = (mode, kind, oid)
    return tree


def read_manifest(repo, tree, names):
    files = {}
    for name in validate_manifest(names):
        entry = tree.get(name)
        if entry is None:
            raise ReleaseError("required committed file is missing: " + name)
        mode, kind, oid = entry
        if mode not in ("100644", "100755") or kind != "blob":
            raise ReleaseError("manifest requires a regular committed file: " + name)
        files[name] = git(repo, "cat-file", "blob", oid)
    return files


def validate_build_inputs(tree):
    # A new non-test Go/assembly/embed input must be consciously allowlisted,
    # not silently omitted from the isolated build or accidentally packaged.
    for name in tree:
        if (name.startswith(("cmd/agent-link/", "internal/link/", "onboarding/"))
                or ("/" not in name and name.endswith(".go"))) and not name.endswith("_test.go"):
            if name not in (*BUILD_FILES, *EMBED_FILES):
                raise ReleaseError("unreviewed build input; update BUILD_FILES: " + name)


def build_environment(epoch):
    env = dict(os.environ)
    env.update({"CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64", "GOAMD64": "v1",
                "GO111MODULE": "on", "GOENV": "off", "GOFLAGS": "", "GOEXPERIMENT": "",
                "GOTOOLCHAIN": "local", "GOWORK": "off", "GOPROXY": "off", "GOSUMDB": "off",
                "GOPRIVATE": "", "GONOPROXY": "", "GONOSUMDB": "",
                "SOURCE_DATE_EPOCH": str(epoch)})
    return env


def metadata(version, commit, epoch, builder_version):
    validate_version(version)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ReleaseError("invalid source commit")
    if type(epoch) is not int or not 0 <= epoch <= 0xFFFFFFFF:
        raise ReleaseError("commit timestamp is outside the reproducible gzip range")
    if not re.fullmatch(r"go[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[a-z]+[0-9]+)?", builder_version):
        raise ReleaseError("a released Go toolchain is required")
    return {"schema_version": 1, "version": version, "source_commit": commit,
            "source_date_epoch": epoch,
            "build_date": datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "target": dict(TARGET), "builder_version": builder_version,
            "packaging_version": PACKAGING_VERSION}


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_binary(source, destination, info, env):
    ldflags = " ".join(("-s", "-w", "-buildid=", "-X", "main.version=" + info["version"],
                        "-X", "main.commit=" + info["source_commit"],
                        "-X", "main.buildDate=" + info["build_date"]))
    result = subprocess.run(["go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
                             "-ldflags", ldflags, "-o", str(destination), "./cmd/agent-link"],
                            cwd=source, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Go diagnostics are useful but may contain local paths. No environment,
        # credentials, provider configs or untracked files are part of the build.
        sys.stderr.buffer.write(result.stderr)
        raise ReleaseError("Go build failed; dependencies must already be cached (downloads are disabled)")


def write_archive(path, root, files, epoch):
    relative_path(root)
    if "/" in root:
        raise ReleaseError("archive root must be one directory name")
    validate_manifest(files)
    # Exclusive creation protects callers as well as the CLI's new-output rule.
    with Path(path).open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(files):
                    data = files[name]
                    entry = tarfile.TarInfo(root + "/" + name)
                    entry.size = len(data)
                    entry.mtime = epoch
                    entry.mode = 0o755 if name == "bin/agent-mesh" else 0o644
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ""
                    archive.addfile(entry, io.BytesIO(data))


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def publish(staging, output, names):
    names = validate_manifest(names)
    if any("/" in name for name in names):
        raise ReleaseError("published assets must be basenames")
    output = validate_output(output)
    output.mkdir(mode=0o700)  # No exist_ok: even an empty existing directory fails.
    for name in names:
        with (staging / name).open("rb") as source, (output / name).open("xb") as destination:
            shutil.copyfileobj(source, destination)
    return output


def release(repo, version, output):
    version = validate_version(version)
    output = validate_output(output)
    repo = Path(repo).resolve(strict=True)
    if Path(git(repo, "rev-parse", "--show-toplevel").decode().strip()).resolve() != repo:
        raise ReleaseError("builder must run from its repository root")
    commit = clean_commit(repo)
    tree = source_tree(repo, commit)
    validate_build_inputs(tree)
    names = tuple(dict.fromkeys((*BUILD_FILES, *EMBED_FILES, *WEB_FILES, *CONNECTOR_FILES,
                               *LICENSE_FILES, INSTALL_SOURCE, NOTICES_SOURCE, "scripts/build-release.py")))
    blobs = read_manifest(repo, tree, names)
    if blobs["scripts/build-release.py"] != Path(__file__).read_bytes():
        raise ReleaseError("running builder does not match the committed builder")
    install_guide = render_install_guide(blobs[INSTALL_SOURCE], version)
    epoch = int(git(repo, "show", "-s", "--format=%ct", commit).strip())
    env = build_environment(epoch)
    toolchain = subprocess.run(["go", "env", "GOVERSION"], cwd=repo, env=env,
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = metadata(version, commit, epoch, toolchain.stdout.decode("ascii").strip())
    release_json = json_bytes(info)
    with tempfile.TemporaryDirectory(prefix="agent-mesh-release-") as temp:
        staging = Path(temp)
        source = staging / "source"
        source.mkdir()
        for name in dict.fromkeys((*BUILD_FILES, *EMBED_FILES)):
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(blobs[name])
        binary = staging / "agent-mesh"
        build_binary(source, binary, info, env)
        common = {**{name: blobs[name] for name in LICENSE_FILES},
                  "INSTALL.md": install_guide, "RELEASE.json": release_json,
                  "THIRD_PARTY_NOTICES.md": blobs[NOTICES_SOURCE]}
        server = {**common, **{name: blobs[name] for name in WEB_FILES}, "bin/agent-mesh": binary.read_bytes()}
        connectors = {**common, **{name: blobs[name] for name in CONNECTOR_FILES}}
        server_root = "agent-mesh_" + version + "_linux_amd64"
        connector_root = "agent-mesh_" + version + "_connectors"
        archives = (server_root + ".tar.gz", connector_root + ".tar.gz")
        write_archive(staging / archives[0], server_root, server, epoch)
        write_archive(staging / archives[1], connector_root, connectors, epoch)
        with (staging / "RELEASE.json").open("xb") as stream:
            stream.write(release_json)
        assets = (*archives, "RELEASE.json")
        checksums = "".join(file_sha256(staging / name) + "  " + name + "\n" for name in sorted(assets))
        with (staging / "SHA256SUMS").open("xb") as stream:
            stream.write(checksums.encode("ascii"))
        clean_commit(repo, expected=commit)
        publish(staging, output, (*assets, "SHA256SUMS"))
    return info


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="v-prefixed release version, e.g. v0.1.0-rc.1")
    parser.add_argument("--output", required=True, help="absolute nonexistent directory; existing parent required")
    args = parser.parse_args(argv)
    try:
        info = release(Path(__file__).resolve().parents[1], args.version, args.output)
    except (ReleaseError, OSError, UnicodeError, subprocess.CalledProcessError) as error:
        print("release build refused: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps({"output": str(Path(args.output)), **info}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
