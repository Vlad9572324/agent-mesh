"""Bounded portable file sets and authenticated immutable artifact handoff.

No code execution, archive tools, implicit checkout, extraction or overwrite.
Credentials are read only from a private regular file and never printed.
"""
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import stat
import urllib.error
import urllib.parse
import urllib.request


MAX_ARTIFACT = 2 << 20
MAX_FILES = 32
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
ROLES = {"baseline", "implementation", "test", "evidence", "bundle"}


def identifier(value):
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def relative_path(value):
    if not isinstance(value, str) or not value or len(value.encode()) > 300:
        return False
    parts = value.split("/")
    return not any(part in ("", ".", "..") for part in parts) and "\\" not in value and ":" not in value and all(ord(c) >= 32 and ord(c) != 127 for c in value) and not PurePosixPath(value).is_absolute()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=object_pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid JSON number")))


def read_regular(path, maximum, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("bounded regular file required")
        if private and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise ValueError("private owned file required")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("file exceeds size limit")
        return data
    finally:
        os.close(fd)


def write_new(path, data):
    """Explicit destination only; never follows/replaces a final path."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def validate_bundle(data, expected_base):
    if not identifier(expected_base) or not isinstance(data, bytes) or not 0 < len(data) <= MAX_ARTIFACT:
        raise ValueError("invalid bundle or expected base")
    try:
        value = strict_json(data)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ValueError("invalid bundle JSON") from error
    if type(value) is not dict or set(value) != {"format_version", "base_revision", "files"} or type(value["format_version"]) is not int or value["format_version"] != 1 or value["base_revision"] != expected_base:
        raise ValueError("bundle format or base mismatch")
    files = value["files"]
    if type(files) is not list or not 0 < len(files) <= MAX_FILES:
        raise ValueError("invalid file count")
    decoded, seen, total = [], set(), 0
    for item in files:
        if type(item) is not dict or set(item) != {"path", "sha256", "content_base64"} or not relative_path(item["path"]) or item["path"] in seen or not isinstance(item["sha256"], str) or not SHA256.fullmatch(item["sha256"]) or not isinstance(item["content_base64"], str):
            raise ValueError("invalid or duplicate bundle file")
        try:
            content = base64.b64decode(item["content_base64"], validate=True)
        except (ValueError, UnicodeError) as error:
            raise ValueError("invalid file encoding") from error
        if base64.b64encode(content).decode() != item["content_base64"] or digest(content) != item["sha256"]:
            raise ValueError("file checksum mismatch")
        total += len(content)
        if total > MAX_ARTIFACT:
            raise ValueError("decoded bundle exceeds limit")
        seen.add(item["path"])
        decoded.append((item["path"], content))
    # A file must never also be a parent directory of another file.
    for name in seen:
        if any(str(parent) in seen for parent in PurePosixPath(name).parents if str(parent) != "."):
            raise ValueError("conflicting bundle paths")
    return decoded


def pack(root, paths, base_revision):
    root = Path(root).resolve(strict=True)
    if not root.is_dir() or root == Path(root.anchor) or not identifier(base_revision) or not 0 < len(paths) <= MAX_FILES or len(set(paths)) != len(paths):
        raise ValueError("invalid pack root, paths or base")
    files = []
    for name in sorted(paths):
        if not relative_path(name):
            raise ValueError("unsafe relative path")
        candidate = root / name
        # No symlinks at any path component, including an otherwise in-root link.
        check = root
        for part in name.split("/"):
            check = check / part
            if check.is_symlink():
                raise ValueError("symlink bundle input refused")
        if not candidate.resolve(strict=True).is_relative_to(root):
            raise ValueError("bundle input outside root")
        content = read_regular(candidate, MAX_ARTIFACT)
        files.append({"path": name, "sha256": digest(content), "content_base64": base64.b64encode(content).decode()})
    data = json.dumps({"format_version": 1, "base_revision": base_revision, "files": files}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    validate_bundle(data, base_revision)
    return data


def unpack(data, expected_base, destination):
    """Explicit operation into a NEW private directory; never a live worktree."""
    files = validate_bundle(data, expected_base)
    destination = Path(destination).absolute()
    if destination == Path(destination.anchor) or destination.parent.resolve() != destination.parent:
        raise ValueError("concrete nonsymlink parent required")
    destination.mkdir(mode=0o700, exist_ok=False)
    # Entire structure validated before creating anything. A failed write leaves
    # a private partial directory for inspection, never deletes user data.
    for name, content in files:
        target = destination / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_new(target, content)
    return {"files": len(files), "base_revision": expected_base, "sha256": digest(data)}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ArtifactClient:
    def __init__(self, origin, key_file, ca_file=None, *, allow_loopback_http=False):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/") or not parsed.hostname:
            raise ValueError("API origin must not contain credentials, path or query")
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = parsed.hostname == "localhost"
        if parsed.scheme != "https" and not (parsed.scheme == "http" and allow_loopback_http and loopback):
            raise ValueError("verified HTTPS required (HTTP only explicit loopback tests)")
        if parsed.port is not None and parsed.port < 1:
            raise ValueError("invalid API port")
        self.origin = origin.rstrip("/")
        self.key = read_regular(key_file, 128, private=True).decode().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", self.key):
            raise ValueError("invalid service key format")
        context = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), _NoRedirect())

    def request(self, path, body=None, *, binary=False):
        if not path.startswith("/v1/") or "?" in path or "#" in path:
            raise ValueError("invalid artifact API path")
        data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Authorization": "Bearer " + self.key, "Accept": "application/octet-stream" if binary else "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.origin + path, data=data, headers=headers)
        try:
            with self.opener.open(req, timeout=20) as response:
                content = response.read(MAX_ARTIFACT + 1)
                if len(content) > MAX_ARTIFACT:
                    raise ValueError("artifact response too large")
                return content if binary else strict_json(content)
        except urllib.error.HTTPError as error:
            # Don't include reflected remote bodies, credentials or full URLs.
            raise RuntimeError("artifact API HTTP " + str(error.code)) from None
        except urllib.error.URLError:
            raise RuntimeError("artifact API connection failed") from None

    def upload(self, project, client_id, role, base_revision, content):
        if not all(identifier(v) for v in (project, client_id, base_revision)) or role not in ROLES or not 0 < len(content) <= MAX_ARTIFACT:
            raise ValueError("invalid upload metadata or size")
        body = {"client_id": client_id, "role": role, "base_revision": base_revision, "sha256": digest(content), "content_base64": base64.b64encode(content).decode()}
        result = self.request("/v1/projects/" + project + "/artifacts", body)
        item = result.get("artifact", {})
        if item.get("sha256") != body["sha256"] or item.get("base_revision") != base_revision or item.get("project_id") != project or item.get("role") != role or item.get("size_bytes") != len(content) or not identifier(item.get("id")):
            raise ValueError("upload receipt mismatch")
        return result

    def download(self, artifact, expected_sha256, expected_base, *, expected_project):
        if not identifier(artifact) or not identifier(expected_project) or not identifier(expected_base) or not SHA256.fullmatch(expected_sha256):
            raise ValueError("invalid pinned artifact reference")
        metadata = self.request("/v1/artifacts/" + artifact).get("artifact", {})
        if metadata.get("id") != artifact or metadata.get("project_id") != expected_project or metadata.get("sha256") != expected_sha256 or metadata.get("base_revision") != expected_base:
            raise ValueError("artifact identity, project, hash or base mismatch")
        data = self.request("/v1/artifacts/" + artifact + "/content", binary=True)
        if not data or len(data) != metadata.get("size_bytes") or digest(data) != expected_sha256:
            raise ValueError("downloaded artifact checksum mismatch")
        return data
