#!/usr/bin/env bash
# The whole bootstrap is parsed before it executes, including piped downloads.
{
set -euo pipefail
command -v python3 >/dev/null || { echo 'Agent Mesh requires Python 3.10 or newer.' >&2; exit 2; }
python3 -B - "$@" <<'AGENT_MESH_INSTALLER_PYTHON'
__INSTALLER_PYTHON__
AGENT_MESH_INSTALLER_PYTHON
}
