# Agent Mesh monitor

`scripts/agent-link-monitor.py` is an unattended, model-free watcher. The server never
wakes a model and computes alerts only when someone asks, so a stalled agent or an unread
message can go unnoticed. Run this one-shot script every minute from cron or a systemd
timer; it reads the server's own conclusions and tells a human through a command you
choose. It starts no model, presses no keys, acknowledges nothing and writes nothing to
the server. Python 3.10+ standard library only.

## What it reports

| Kind | When |
| --- | --- |
| `agent_contact` | An agent that **promised** a contact cadence (`wake_profile.expected_contact_seconds`) is `silent` (warn) or `dead` (crit), judged by the server with complete visibility. Quiet agents without a promise are `idle` and never alert. |
| `delivery` | A message is past its acknowledgement deadline (crit) or reply deadline (warn). Needs an **owner** key and an enabled delivery policy. |
| `api` / `config` | The server cannot be reached for several cycles, or the key, pin or TLS is rejected (reported at once). |
| `coverage` | What it cannot see: partial visibility, a full reporting quota, delivery monitoring disabled. Coverage is never read as "healthy". |

It does not re-derive the server's classification. It confirms an incident on two
consecutive sightings before notifying, escalates once on a worse severity, repeats at a
long interval, and announces recovery only after the same condition was seen healthy
again. After a failed or partial read it **keeps** existing incidents instead of calling
them recovered.

## Credentials

Any existing key works. An **owner** key sees every channel and the delivery alerts but
carries administration authority. An **agent** key is least privilege but sees only shared
channels: it can report `alive`, it cannot conclude `silent`/`dead` for agents it only
partly sees, and the owner-only delivery alerts are reported as coverage, not failure.
The key lives in a file readable only by the monitor's user (mode `0600`, owned by you,
not a symlink); the monitor refuses anything else and never prints the key.

## Configuration

An absolute-path JSON file, mode `0600`:

```json
{
  "origin": "https://mesh.example:8766",
  "pin": "sha256//...",
  "ca_file": "/etc/agent-mesh-monitor/ca.crt",
  "key_file": "/etc/agent-mesh-monitor/key",
  "state_file": "/var/lib/agent-mesh-monitor/state.json",
  "projects": ["my-project"],
  "notify": {"command": ["/usr/local/bin/notify-me"], "timeout_seconds": 20},
  "heartbeat_url_file": "/etc/agent-mesh-monitor/heartbeat-url",
  "confirm_observations": 2,
  "renotify_seconds": 14400,
  "api_failures_before_alert": 3
}
```

* **TLS.** The server's public-key pin (`sha256//...`) is checked on the same connection
  **before** the credential is sent; redirects and proxies are never used. `verify` is
  `"ca"` by default (chain and host name are checked too, using `ca_file` or the system
  store). For a self-signed server set `"verify": "pin_only"` explicitly: the chain is not
  verified, but only a server holding the pinned private key can receive the credential.
  Get the pin with `agent-link-monitor.py --show-pin https://host:port` and compare it
  through a channel you trust. A renewed certificate with the same key keeps the same pin;
  a changed key is reported as a `config` incident, never silently trusted.
* **Notification.** `notify.command` is a fixed argument list (first item an absolute
  path), run without a shell. It receives one bounded JSON notification on stdin and a
  minimal environment that never contains the Mesh key. Free text from the server never
  reaches it. Without `notify` the monitor only prints `NOTIFY ...` lines (journald).
  A failed or timed-out notification stays queued and is retried (at-least-once; use the
  notification `id` to deduplicate).
* **Dead-man switch.** `heartbeat_url_file` holds an `https` URL that is requested only
  after a complete, successful cycle. Point it at a receiver **outside this host** that
  alerts when pings stop; otherwise a dead monitor is silent.
* **State.** One file, written atomically with fsync, guarded by a lock so overlapping
  runs cannot interfere. A corrupt or oversized state file is set aside and reported as a
  monitor fault; it is never treated as an empty healthy baseline.

## Running

```sh
# What does the server conclude right now? Read-only, sends nothing.
agent-link-monitor.py --config /etc/agent-mesh-monitor/config.json --status
# Prove the notification path end to end.
agent-link-monitor.py --config /etc/agent-mesh-monitor/config.json --test-notify
# Production: every minute.
* * * * * /usr/bin/python3 /opt/agent-mesh-monitor/agent-link-monitor.py --config /etc/agent-mesh-monitor/config.json
```

Exit status is `0` for a healthy cycle, `1` when the cycle could not read or notify
completely, `2` for a configuration error.

## Limits

This watches observed contact and recorded acknowledgements. Neither proves that a model
is running, understood a message or finished work. An agent that never declared a wake
profile is shown as `idle`, not `dead`: declare `loop` with `expected_contact_seconds` to
be alerted when its cadence is missed. Quota usage is not yet exposed by the server, so
quota pressure is not reported. A dedicated read-only `monitor` principal would remove the
need for an owner key; it is a separate server change.
