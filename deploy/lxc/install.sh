#!/usr/bin/env bash
# First installation only; run inside the newly provisioned, explicitly marked LXC.
set -euo pipefail
umask 077

fail() { printf 'agent-link install: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' \
    'Usage: install.sh prepare RELEASE /absolute/bundle PG_VERSION/CLUSTER' \
    '       install.sh activate' \
    'Requires root, LXC, and /etc/agent-link-lxc-target containing agent-link-lxc-v1.' >&2
  exit 2
}
require_command() { command -v "$1" >/dev/null || fail "Required command is missing: $1"; }
root_file() {
  [[ -f "$1" && ! -L "$1" ]] || fail "Expected a regular, non-symlink file: $1"
  [[ $(stat -c %u "$1") == 0 ]] || fail "File must be root-owned: $1"
  local mode
  mode=$(stat -c %a "$1")
  (( (8#$mode & 0022) == 0 )) || fail "File must not be group/world writable: $1"
}
browser_compatible_certificate() {
  # Inspect the first (leaf) certificate, not its issuer's signature algorithm.
  # Fail closed for unsupported/unrecognized key formats and explicit EC params.
  local details algorithm bits curve
  details=$(LC_ALL=C openssl x509 -in "$1" -noout -text 2>/dev/null) || return 1
  algorithm=$(awk '/^[[:space:]]*Public Key Algorithm: / { sub(/^[[:space:]]*Public Key Algorithm: /, ""); print; exit }' <<< "$details")
  case "$algorithm" in
    rsaEncryption)
      bits=$(awk '/^[[:space:]]*Public-Key: / { gsub(/[^0-9]/, "", $2); print $2; exit }' <<< "$details")
      [[ $bits =~ ^[0-9]{1,6}$ ]] && (( 10#$bits >= 2048 ))
      ;;
    id-ecPublicKey)
      curve=$(awk '/^[[:space:]]*ASN1 OID: / { sub(/^[[:space:]]*ASN1 OID: /, ""); print; exit }' <<< "$details")
      [[ $curve == prime256v1 || $curve == secp384r1 ]]
      ;;
    *) return 1 ;;
  esac
}
read_cluster() {
  local spec=$1 details
  [[ $spec =~ ^([0-9]+)/([a-zA-Z0-9_]+)$ ]] || fail 'Invalid PG cluster; expected VERSION/NAME'
  pg_version=${BASH_REMATCH[1]}
  pg_name=${BASH_REMATCH[2]}
  pg_unit="postgresql@${pg_version}-${pg_name}.service"
  details=$(pg_lsclusters --no-header | awk -v v="$pg_version" -v n="$pg_name" '$1 == v && $2 == n { print $3 " " $5 }')
  [[ $details == '5432 postgres' ]] || fail 'Expected exactly one postgres-owned cluster on port 5432'
}

[[ ${EUID:-$(id -u)} == 0 ]] || fail 'Run as root only inside the new target LXC'
for command_name in systemd-detect-virt stat systemctl pg_lsclusters runuser psql; do
  require_command "$command_name"
done
[[ $(systemd-detect-virt --container) == lxc ]] || fail 'Refusing installation outside LXC'
[[ $(< /proc/1/comm) == systemd ]] || fail 'Target must boot with systemd'
marker=/etc/agent-link-lxc-target
root_file "$marker"
[[ $(stat -c '%u:%g:%a' "$marker") == '0:0:600' ]] || fail 'Target marker must be root:root mode 0600'
[[ $(< "$marker") == agent-link-lxc-v1 ]] || fail 'Target marker does not match'

action=${1:-}
case "$action" in
  prepare)
    [[ $# == 4 ]] || usage
    release=$2
    bundle=$3
    [[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$ ]] || fail 'Invalid release identifier'
    [[ $bundle == /* && -d $bundle && ! -L $bundle ]] || fail 'Bundle must be an absolute, non-symlink directory'
    [[ $(stat -c '%u:%g:%a' "$bundle") == '0:0:700' ]] || fail 'Bundle directory must be root:root mode 0700'
    read_cluster "$4"
    for command_name in install useradd getent openssl sha256sum; do
      require_command "$command_name"
    done
    script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
    root_file "$script_dir/agent-link.service"
    for name in agent-link web/index.html web/app.js web/app.css server.crt server.key; do
      root_file "$bundle/$name"
    done
    [[ -d $bundle/web && ! -L $bundle/web ]] || fail 'Bundle web directory must not be a symlink'
    [[ $(stat -c '%u:%a' "$bundle/web") == '0:700' ]] || fail 'Bundle web directory must be root-owned mode 0700'
    [[ $(stat -c %a "$bundle/server.key") == 600 ]] || fail 'Staged TLS private key must be mode 0600'
    openssl x509 -in "$bundle/server.crt" -noout -checkend 86400 >/dev/null 2>&1 || fail 'Certificate must remain valid for at least 24 hours'
    browser_compatible_certificate "$bundle/server.crt" || fail 'TLS leaf key must be RSA >=2048 bits (rsaEncryption) or named-curve EC P-256/P-384; Ed25519/Ed448 are not supported for this GUI deployment'
    cert_public=$(openssl x509 -in "$bundle/server.crt" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)
    key_public=$(openssl pkey -in "$bundle/server.key" -passin pass: -pubout -outform DER 2>/dev/null | sha256sum)
    [[ $cert_public == "$key_public" ]] || fail 'TLS certificate/private key do not match'
    for target in /opt/agent-link /etc/agent-link /etc/systemd/system/agent-link.service /etc/systemd/system/agent-link.service.d; do
      [[ ! -e $target && ! -L $target ]] || fail "Existing installation path; no files changed: $target"
    done
    [[ ! -L /etc/systemd/system/"$pg_unit".d ]] || fail 'PG drop-in directory must not be a symlink'
    [[ ! -e /etc/systemd/system/"$pg_unit".d/agent-link-restart.conf && ! -L /etc/systemd/system/"$pg_unit".d/agent-link-restart.conf ]] || fail 'Existing PG restart drop-in; refusing replacement'
    if getent passwd agent-link >/dev/null || getent group agent-link >/dev/null; then
      fail 'The agent-link OS account or group already exists; inspect before installation'
    fi
    systemctl is-active --quiet agent-link.service && fail 'An Agent Mesh service is already active'

    useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin agent-link
    destination="/opt/agent-link/releases/$release"
    install -d -o root -g root -m 0755 /opt/agent-link /opt/agent-link/releases "$destination" "$destination/web"
    install -o root -g root -m 0755 "$bundle/agent-link" "$destination/agent-link"
    for name in index.html app.js app.css; do
      install -o root -g root -m 0644 "$bundle/web/$name" "$destination/web/$name"
    done
    install -d -o root -g agent-link -m 0750 /etc/agent-link
    install -o root -g agent-link -m 0640 "$bundle/server.crt" /etc/agent-link/server.crt
    install -o agent-link -g agent-link -m 0600 "$bundle/server.key" /etc/agent-link/server.key
    printf '%s\n' 'postgresql://agent-link@/agentlink?host=/var/run/postgresql&port=5432&sslmode=disable' > /etc/agent-link/database-url
    chown agent-link:agent-link /etc/agent-link/database-url
    chmod 0600 /etc/agent-link/database-url
    printf '%s\n' "$4" > /etc/agent-link/pg-cluster
    ln -s "releases/$release" /opt/agent-link/current
    install -o root -g root -m 0644 "$script_dir/agent-link.service" /etc/systemd/system/agent-link.service
    install -d -o root -g root -m 0755 /etc/systemd/system/agent-link.service.d /etc/systemd/system/"$pg_unit".d
    printf '[Unit]\nWants=%s\nAfter=%s\n' "$pg_unit" "$pg_unit" > /etc/systemd/system/agent-link.service.d/postgresql.conf
    printf '[Unit]\nStartLimitIntervalSec=0\n[Service]\nRestart=on-failure\nRestartSec=5s\n' > /etc/systemd/system/"$pg_unit".d/agent-link-restart.conf
    chmod 0644 /etc/systemd/system/agent-link.service.d/postgresql.conf /etc/systemd/system/"$pg_unit".d/agent-link-restart.conf
    systemctl daemon-reload
    printf '%s\n' 'Prepared only. Restore the existing database as documented, then run install.sh activate.'
    ;;
  activate)
    [[ $# == 1 ]] || usage
    require_command openssl
    root_file /etc/agent-link/pg-cluster
    read_cluster "$(< /etc/agent-link/pg-cluster)"
    root_file /etc/systemd/system/agent-link.service
    root_file /etc/agent-link/server.crt
    browser_compatible_certificate /etc/agent-link/server.crt || fail 'TLS leaf key must be RSA >=2048 bits (rsaEncryption) or named-curve EC P-256/P-384; Ed25519/Ed448 are not supported for this GUI deployment'
    [[ -x /opt/agent-link/current/agent-link ]] || fail 'Prepared release is missing'
    for private_file in database-url server.key; do
      [[ -f /etc/agent-link/$private_file && ! -L /etc/agent-link/$private_file ]] || fail 'Prepared private file is missing or unsafe'
      [[ $(stat -c '%U:%G:%a' /etc/agent-link/"$private_file") == 'agent-link:agent-link:600' ]] || fail 'Private app files must be agent-link:agent-link mode 0600'
    done
    # Never seed an empty DB or rotate a key. Require existing application data,
    # correct owner, and peer-authenticated access before enabling boot startup.
    state=$(runuser -u agent-link -- env -i PATH=/usr/bin:/bin psql --host=/var/run/postgresql --port=5432 --username=agent-link --dbname=agentlink --no-password -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_user = 'agent-link' AND EXISTS (SELECT 1 FROM principals) AND EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND pg_get_userbyid(datdba) = current_user) AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner <> current_user);") || fail 'Restored database/schema/peer authentication check failed'
    [[ $state == t ]] || fail 'Database is empty or is not owned by agent-link; no bootstrap performed'
    listeners=$(runuser -u postgres -- env -i PATH=/usr/bin:/bin psql --host=/var/run/postgresql --port=5432 --username=postgres --dbname=postgres --no-password -X -qAt -v ON_ERROR_STOP=1 -c 'SHOW listen_addresses;')
    [[ -z $listeners ]] || fail 'PostgreSQL must be Unix-socket-only; set listen_addresses to an empty string and restart its cluster'
    systemctl enable postgresql.service "$pg_unit" agent-link.service
    systemctl start "$pg_unit" agent-link.service
    for service in "$pg_unit" agent-link.service; do
      systemctl is-active --quiet "$service" || fail "Service did not start; inspect its journal: $service"
    done
    printf '%s\n' 'PostgreSQL and Agent Mesh enabled and started. Verify certificate-trusted HTTPS readiness and existing credentials before cutover.'
    ;;
  *) usage ;;
esac
