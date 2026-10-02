#!/usr/bin/env bash
# Update code/assets only on the explicitly provisioned Agent Mesh node.
set -euo pipefail
umask 077
fail() { printf 'agent-link update: %s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 && $# == 3 ]] || fail 'Usage (root): update.sh RELEASE /absolute/bundle EXPECTED_CURRENT_RELEASE'
release=$1 bundle=$2 expected=$3
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ && $expected =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || fail 'Invalid release IDs'
expected_hostname=${AGENT_LINK_EXPECTED_HOSTNAME:-}
[[ $expected_hostname =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]] || fail 'Set AGENT_LINK_EXPECTED_HOSTNAME to the explicitly approved short DNS hostname'
[[ $(hostname -s) == "$expected_hostname" && $(systemd-detect-virt --container) == lxc ]] || fail 'Wrong target'
[[ -f /etc/agent-link-lxc-target && ! -L /etc/agent-link-lxc-target ]] || fail 'Missing target marker'
[[ $(stat -c '%u:%g:%a' /etc/agent-link-lxc-target) == '0:0:600' && $(< /etc/agent-link-lxc-target) == agent-link-lxc-v1 ]] || fail 'Unsafe marker'
exec 9>/run/agent-link-update.lock
flock -n 9 || fail 'Another update is running'
[[ $(readlink /opt/agent-link/current) == "releases/$expected" ]] || fail 'Current release changed; inspect before updating'
[[ $bundle == /* && -d $bundle && ! -L $bundle && $(stat -c '%u:%g:%a' "$bundle") == '0:0:700' ]] || fail 'Unsafe bundle directory'
[[ -d $bundle/web && ! -L $bundle/web && $(stat -c '%u:%g:%a' "$bundle/web") == '0:0:700' ]] || fail 'Unsafe web directory'
for name in agent-link web/index.html web/app.js web/app.css SHA256SUMS; do
  path="$bundle/$name"
  [[ -f $path && ! -L $path && $(stat -c %u "$path") == 0 ]] || fail "Unsafe bundle file: $name"
  mode=$(stat -c %a "$path")
  (( (8#$mode & 0022) == 0 )) || fail "Writable bundle file: $name"
done
# The manifest contains only four exact allowlisted relative paths.
awk 'NF != 2 || $1 !~ /^[0-9a-f]+$/ || length($1) != 64 { bad=1 }
     $2 != "agent-link" && $2 != "web/index.html" && $2 != "web/app.js" && $2 != "web/app.css" { bad=1 }
     { if (seen[$2]++) bad=1 }
     END { exit (bad || NR != 4) }' "$bundle/SHA256SUMS" || fail 'Invalid manifest'
(cd "$bundle" && sha256sum --check --strict SHA256SUMS) || fail 'Artifact checksum mismatch'
destination="/opt/agent-link/releases/$release"
backup="/var/lib/postgresql/agent-link-backups/$release"
[[ ! -e $destination && ! -L $destination && ! -e $backup && ! -L $backup ]] || fail 'Release/backup already exists'
[[ ! -e /opt/agent-link/current.next && ! -L /opt/agent-link/current.next ]] || fail 'Pending release pointer exists'
systemctl is-active --quiet agent-link.service || fail 'Existing service is not active'
curl --fail --silent --show-error --max-time 10 --cacert /etc/agent-link/ca.crt https://127.0.0.1:8766/healthz
install -d -o root -g root -m 0755 "$destination" "$destination/web"
install -o root -g root -m 0755 "$bundle/agent-link" "$destination/agent-link"
for name in index.html app.js app.css; do
  install -o root -g root -m 0644 "$bundle/web/$name" "$destination/web/$name"
done
install -o root -g root -m 0644 "$bundle/SHA256SUMS" "$destination/SHA256SUMS"
(cd "$destination" && sha256sum --check --strict SHA256SUMS) || fail 'Installed artifact checksum mismatch'
install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/agent-link-backups "$backup"
runuser -u postgres -- env -i PATH=/usr/bin:/bin /usr/bin/pg_dump --host=/var/run/postgresql --port=5432 --username=postgres --no-password --format=custom --no-owner --no-acl --dbname=agentlink --file="$backup/agentlink.dump"
chmod 0600 "$backup/agentlink.dump"
runuser -u postgres -- env -i PATH=/usr/bin:/bin /usr/bin/pg_restore --list "$backup/agentlink.dump" >/dev/null
sha256sum "$backup/agentlink.dump"
rollback() {
  local status=${1:-1}
  trap - ERR HUP INT TERM
  ln -sfn "releases/$expected" /opt/agent-link/current.next
  mv -Tf /opt/agent-link/current.next /opt/agent-link/current
  if systemctl restart agent-link.service && curl --retry 20 --retry-connrefused --retry-delay 1 --max-time 5 --fail --silent --show-error --cacert /etc/agent-link/ca.crt https://127.0.0.1:8766/healthz; then
    printf 'Update failed; previous release restored and healthy. Retained candidate and backup.\n' >&2
  else
    printf 'Update failed; previous release selected but recovery health FAILED. Manual service inspection required.\n' >&2
  fi
  exit "$status"
}
trap 'rollback "$?"' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM
systemctl stop agent-link.service
ln -s "releases/$release" /opt/agent-link/current.next
mv -Tf /opt/agent-link/current.next /opt/agent-link/current
systemctl start agent-link.service
curl --retry 20 --retry-connrefused --retry-delay 1 --max-time 5 --fail --silent --show-error --cacert /etc/agent-link/ca.crt https://127.0.0.1:8766/healthz
systemctl is-active --quiet agent-link.service
trap - ERR HUP INT TERM
printf 'Updated to %s; previous release %s and database backup retained.\n' "$release" "$expected"
