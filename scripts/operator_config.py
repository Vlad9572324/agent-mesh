"""Explicit local operator settings; importing this module has no side effects."""
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def required_env(name, env=None):
    value = (os.environ if env is None else env).get(name)
    if (not isinstance(value, str) or not value or value != value.strip()
            or re.search(r"[\x00-\x1f\x7f]", value)):
        raise ValueError(f"Set {name} explicitly; empty, padded or control-character values are not accepted")
    return value


def required_path(name, env=None):
    value = Path(required_env(name, env))
    if not value.is_absolute():
        raise ValueError(f"{name} must be an absolute local path")
    return value.resolve()


def runtime_dir(env=None):
    path = required_path("AGENT_LINK_RUNTIME_DIR", env)
    repo = REPOSITORY_ROOT.resolve()
    if (path == path.parent or path == Path.home().resolve()
            or path == repo or repo in path.parents or path in repo.parents):
        raise ValueError("AGENT_LINK_RUNTIME_DIR must be a dedicated directory outside the source checkout")
    if path.exists() and not path.is_dir():
        raise ValueError("AGENT_LINK_RUNTIME_DIR is not a directory")
    return path


def service_origin(env=None):
    value = required_env("AGENT_LINK_ORIGIN", env)
    if not re.fullmatch(r"https://[^/?#\\\s]+/?", value, re.IGNORECASE):
        raise ValueError("AGENT_LINK_ORIGIN must be a bare HTTPS origin")
    try:
        url = urlsplit(value)
        port = url.port  # Validate numeric/range constraints before using the URL.
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError()
    except ValueError:
        raise ValueError("AGENT_LINK_ORIGIN must not contain credentials, a path, query or fragment") from None
    return "https://" + url.netloc


def certificate_file(env=None):
    return required_path("AGENT_LINK_CA_FILE", env)


def browser_executable(env=None):
    return required_path("AGENT_LINK_CHROME", env)
