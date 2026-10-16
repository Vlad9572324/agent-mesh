#!/usr/bin/env python3
"""Explicit portable artifact pack/upload/download/unpack; no execution."""
import argparse
import json
import os
from pathlib import Path
import sys

from artifact_client import ArtifactClient, MAX_ARTIFACT, digest, pack, read_regular, unpack, validate_bundle, write_new


def connected_transport(config_path):
    """Resolve transport only from the connector's strict private configuration."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "adapters"))
    from native_bridge import load_config
    config = load_config(Path(config_path))
    return config["url"], config["key_file"], config.get("ca_file"), config["project_id"]


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("pack")
    p.add_argument("--root", required=True)
    p.add_argument("--path", action="append", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--output", required=True)
    for name in ("upload", "download"):
        p = commands.add_parser(name)
        p.add_argument("--config", help="private connector config; derives URL, key, CA and project")
        p.add_argument("--url")
        p.add_argument("--key-file")
        p.add_argument("--ca-file")
        p.add_argument("--allow-loopback-http", action="store_true")
        p.add_argument("--project")
        p.add_argument("--base", required=True, help="Exact source or document revision identifier (e.g. requirements-v1); not an invented Git SHA")
        if name == "upload":
            p.add_argument("--input", required=True)
            p.add_argument("--client-id", required=True)
            p.add_argument("--role", required=True, choices=("baseline", "implementation", "test", "evidence", "bundle", "document"))
            p.add_argument("--title", default="", help="Optional public title, one line and at most 200 UTF-8 bytes")
        else:
            p.add_argument("--artifact", required=True)
            p.add_argument("--sha256", required=True)
            p.add_argument("--output", required=True)
    p = commands.add_parser("unpack")
    p.add_argument("--input", required=True)
    p.add_argument("--base", required=True)
    p.add_argument("--destination", required=True)
    args = parser.parse_args()
    if args.command == "pack":
        data = pack(args.root, args.path, args.base)
        write_new(args.output, data)
        result = {"sha256": digest(data), "size_bytes": len(data), "base_revision": args.base}
    elif args.command == "unpack":
        data = read_regular(args.input, MAX_ARTIFACT)
        result = unpack(data, args.base, args.destination)
    else:
        if args.config:
            if any((args.url, args.key_file, args.ca_file, args.project, args.allow_loopback_http)):
                raise ValueError("--config cannot be combined with manual transport arguments")
            url, key_file, ca_file, project = connected_transport(args.config)
        else:
            if not args.url or not args.key_file or not args.project:
                raise ValueError("manual transport requires --url, --key-file and --project")
            url, key_file, ca_file, project = args.url, args.key_file, args.ca_file, args.project
        client = ArtifactClient(url, key_file, ca_file, allow_loopback_http=args.allow_loopback_http)
        if args.command == "upload":
            data = read_regular(args.input, MAX_ARTIFACT)
            if args.role == "bundle":
                validate_bundle(data, args.base)
            result = client.upload(project, args.client_id, args.role, args.base, data, title=args.title)
        else:
            data = client.download(args.artifact, args.sha256, args.base, expected_project=project)
            write_new(args.output, data)
            result = {"artifact_id": args.artifact, "sha256": digest(data), "size_bytes": len(data), "base_revision": args.base}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError) as error:
        # Paths/remote text in exception chains can contain private material.
        print("Artifact operation refused or failed (" + type(error).__name__ + "); no automatic retry.", file=sys.stderr)
        raise SystemExit(1)
