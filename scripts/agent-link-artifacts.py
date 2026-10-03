#!/usr/bin/env python3
"""Explicit portable artifact pack/upload/download/unpack; no execution."""
import argparse
import json
import os
import sys

from artifact_client import ArtifactClient, MAX_ARTIFACT, digest, pack, read_regular, unpack, validate_bundle, write_new


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
        p.add_argument("--url", required=True)
        p.add_argument("--key-file", required=True)
        p.add_argument("--ca-file")
        p.add_argument("--allow-loopback-http", action="store_true")
        p.add_argument("--project", required=True)
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
        client = ArtifactClient(args.url, args.key_file, args.ca_file, allow_loopback_http=args.allow_loopback_http)
        if args.command == "upload":
            data = read_regular(args.input, MAX_ARTIFACT)
            if args.role == "bundle":
                validate_bundle(data, args.base)
            result = client.upload(args.project, args.client_id, args.role, args.base, data, title=args.title)
        else:
            data = client.download(args.artifact, args.sha256, args.base, expected_project=args.project)
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
