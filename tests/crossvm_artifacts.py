"""Explicit two-filesystem handoff against isolated E2E staging, no model calls.

Starts an owned TLS candidate on an explicitly configured source address and
executes a bounded receiver in an explicitly configured LXC over verified SSH.
No live service API/database or provider credentials are used or changed.
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from artifact_client import ArtifactClient, digest, pack, read_regular, write_new
from operator_config import runtime_dir, service_origin, certificate_file, required_env, required_path


def probe_settings(env=None):
    """Validate every external target before creating files or starting children."""
    env = os.environ if env is None else env
    runtime = runtime_dir(env)
    origin = service_origin(env)
    ca = certificate_file(env)
    try:
        bind_ip = ipaddress.IPv4Address(required_env("AGENT_LINK_TEST_BIND_IP", env))
    except ipaddress.AddressValueError:
        raise ValueError("AGENT_LINK_TEST_BIND_IP must be an IPv4 address") from None
    if bind_ip.is_unspecified or bind_ip.is_multicast or bind_ip.is_loopback:
        raise ValueError("AGENT_LINK_TEST_BIND_IP must be an explicit non-loopback unicast address")
    url = urlsplit(origin)
    if url.hostname != str(bind_ip):
        raise ValueError("AGENT_LINK_ORIGIN must name the exact AGENT_LINK_TEST_BIND_IP")
    remote = required_env("AGENT_LINK_TEST_SSH_TARGET", env)
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", remote):
        raise ValueError("AGENT_LINK_TEST_SSH_TARGET must be an explicit account@host, without options")
    vmid = required_env("AGENT_LINK_TEST_LXC_VMID", env)
    if not re.fullmatch(r"[1-9][0-9]{0,8}", vmid):
        raise ValueError("AGENT_LINK_TEST_LXC_VMID must be a positive decimal identifier")
    hostname = required_env("AGENT_LINK_TEST_RECEIVER_HOSTNAME", env)
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", hostname):
        raise ValueError("AGENT_LINK_TEST_RECEIVER_HOSTNAME must be an explicit short hostname")
    marker_path = required_path("AGENT_LINK_TEST_RECEIVER_MARKER_FILE", env)
    marker = required_env("AGENT_LINK_TEST_RECEIVER_MARKER", env)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", marker):
        raise ValueError("AGENT_LINK_TEST_RECEIVER_MARKER must be a simple marker identifier")
    return {"runtime": runtime, "origin": origin, "ca": ca, "bind_ip": str(bind_ip), "port": url.port or 443,
            "remote": remote, "vmid": vmid, "receiver_hostname": hostname,
            "receiver_marker_file": str(marker_path), "receiver_marker": marker}


def receiver_command(vmid, runner):
    if not re.fullmatch(r"[1-9][0-9]{0,8}", vmid):
        raise ValueError("Invalid receiver LXC identifier")
    return shlex.join(["pct", "exec", vmid, "--", "python3", "-c", runner])


RECEIVER = r'''
import hashlib, json, os, pathlib, socket, tempfile
os.umask(0o077)
if socket.gethostname().split('.')[0] != config['receiver_hostname']:
    raise RuntimeError('receiver identity mismatch')
marker = pathlib.Path(config['receiver_marker_file']).read_text().strip()
if marker != config['receiver_marker']:
    raise RuntimeError('receiver marker mismatch')
space = pathlib.Path(tempfile.mkdtemp(prefix='agent-link-artifact-probe-', dir='/var/tmp'))
key_path, denied_path, ca_path = space/'reader.key', space/'denied.key', space/'ca.crt'
namespace = {}
exec(compile(config['client_source'], '<owned-artifact-client>', 'exec'), namespace)
for path, content in [(key_path, config['reader_key']), (denied_path, config['denied_key']), (ca_path, config['ca'])]:
    namespace['write_new'](path, content.encode())
try:
    client = namespace['ArtifactClient'](config['origin'], key_path, ca_path)
    data = client.download(config['artifact_id'], config['sha256'], config['base'], expected_project='pilot')
    namespace['write_new'](space/'received.bundle', data)
    result = namespace['unpack'](data, config['base'], space/'reconstructed')
    checks = {}
    for label, sha, base, project in [
        ('wrong_base_rejected', config['sha256'], 'wrong-base', 'pilot'),
        ('wrong_hash_rejected', '0'*64, config['base'], 'pilot'),
        ('wrong_project_rejected', config['sha256'], config['base'], 'isolated')]:
        try:
            client.download(config['artifact_id'], sha, base, expected_project=project)
            checks[label] = False
        except ValueError:
            checks[label] = True
    denied = namespace['ArtifactClient'](config['origin'], denied_path, ca_path)
    try:
        denied.download(config['artifact_id'], config['sha256'], config['base'], expected_project='pilot')
        checks['unauthorized_reader_rejected'] = False
    except RuntimeError as error:
        checks['unauthorized_reader_rejected'] = str(error) == 'artifact API HTTP 404'
    files = {name: hashlib.sha256((space/'reconstructed'/name).read_bytes()).hexdigest()
             for name, _ in namespace['validate_bundle'](data, config['base'])}
    machine = hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes()).hexdigest()
    output = {'passed': all(checks.values()), 'receiver_hostname': socket.gethostname(),
              'machine_id_hash': machine, 'artifact_id': config['artifact_id'],
              'sha256': hashlib.sha256(data).hexdigest(), 'file_hashes': files,
              'checks': checks, 'private_artifact_directory': str(space),
              'bytes': len(data), 'file_count': result['files']}
finally:
    # Only our just-created isolated-test credential copies are removed.
    key_path.unlink(missing_ok=True)
    denied_path.unlink(missing_ok=True)
print(json.dumps(output))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-probe", action="store_true", required=True)
    args = parser.parse_args()
    settings = probe_settings()
    runtime, origin = settings['runtime'], settings['origin']
    os.umask(0o077)
    run = "crossvm-artifacts-" + uuid.uuid4().hex[:12]
    directory = Path(tempfile.mkdtemp(prefix=run + "-", dir=runtime / "development"))
    binary = ROOT / "bin/agent-link-coordination-candidate"
    source = directory / "source"
    source.mkdir(mode=0o700)
    write_new(source / "example.py", b"def add(a, b):\n    return a + b\n")
    write_new(source / "test_example.py", b"from example import add\nassert add(2, 3) == 5\n")
    base = hashlib.sha256(b"explicit isolated fixture base v1").hexdigest()
    bundle = pack(source, ["example.py", "test_example.py"], base)
    keys = json.loads(read_regular(runtime / "secrets/e2e-credentials.json", 16384, private=True))["keys"]
    writer_key = directory / "writer.key"
    write_new(writer_key, keys["claude-pilot"].encode())
    ca = settings['ca']
    tls_context = ssl.create_default_context(cafile=str(ca))
    report = {"run": run, "source_hostname": socket.gethostname(), "origin": origin,
              "source_machine_id_hash": digest(Path("/etc/machine-id").read_bytes()),
              "isolated_database": "agentlink_e2e", "live_service_changed": False,
              "models_invoked": False, "shared_filesystem_used_for_handoff": False,
              "passed": False, "started_at": time.time()}
    # Refuse an occupied listener instead of accidentally probing another server.
    with socket.socket() as check:
        check.bind((settings['bind_ip'], settings['port']))
    with (directory / "candidate.log").open("xb") as log:
        child = subprocess.Popen([str(binary), "serve", "--database-url-file", str(runtime / "secrets/agentlink_e2e-dsn"),
                                  "--listen", f"{settings['bind_ip']}:{settings['port']}", "--web-dir", str(ROOT / "web"),
                                  "--tls-cert", str(runtime / "secrets/server.crt"), "--tls-key", str(runtime / "secrets/server.key")],
                                 stdout=log, stderr=log, start_new_session=True)
        report["owned_server_pid"] = child.pid
        try:
            ready = False
            for _ in range(60):
                if child.poll() is not None:
                    raise RuntimeError("owned candidate exited")
                try:
                    with urllib.request.urlopen(origin + "/healthz", context=tls_context, timeout=2) as response:
                        ready = response.status == 200
                    if ready:
                        break
                except OSError:
                    pass
                time.sleep(.1)
            if not ready:
                raise RuntimeError("candidate not ready")
            client = ArtifactClient(origin, writer_key, ca)
            first = client.upload("pilot", run, "bundle", base, bundle)
            second = client.upload("pilot", run, "bundle", base, bundle)
            artifact = first["artifact"]
            if second["artifact"]["id"] != artifact["id"] or not second["replayed"]:
                raise RuntimeError("publication not idempotent")
            packet = {"program": RECEIVER, "client_source": (ROOT / "scripts/artifact_client.py").read_text(),
                      "origin": origin, "ca": ca.read_text(), "reader_key": keys["codex-pilot"],
                      "denied_key": keys["deny-pilot"], "artifact_id": artifact["id"],
                      "sha256": digest(bundle), "base": base,
                      **{name: settings[name] for name in ('receiver_hostname', 'receiver_marker_file', 'receiver_marker')}}
            # Private credentials use encrypted stdin, never command arguments,
            # environment logs or live service accounts. The program is ours.
            runner = "import json,sys;p=json.load(sys.stdin);exec(compile(p.pop('program'),'<owned-probe>','exec'),{'config':p})"
            command = receiver_command(settings['vmid'], runner)
            remote = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "--", settings['remote'], command],
                                    input=json.dumps(packet), capture_output=True, text=True, timeout=75)
            if remote.returncode:
                raise RuntimeError("remote receiver failed; no credentials or remote stderr published")
            result = json.loads(remote.stdout)
            expected_files = {name: digest((source / name).read_bytes()) for name in ("example.py", "test_example.py")}
            if not result["passed"] or result["sha256"] != digest(bundle) or result["file_hashes"] != expected_files or result["machine_id_hash"] == report["source_machine_id_hash"]:
                raise RuntimeError("two-host artifact acceptance failed")
            report.update(receiver=result, publication_replayed=True, artifact=artifact, passed=True)
        except Exception as error:
            report["error_type"] = type(error).__name__
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            writer_key.unlink(missing_ok=True)
            report["server_stopped"] = child.poll() is not None
            report["finished_at"] = time.time()
            write_new(directory / "evidence.json", (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({"passed": report["passed"], "server_stopped": report["server_stopped"],
                      "evidence": str(directory / "evidence.json"), "receiver": report.get("receiver", {})}))
    return 0 if report["passed"] and report["server_stopped"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
