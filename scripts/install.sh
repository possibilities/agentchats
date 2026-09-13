#!/bin/bash

set -euo pipefail

# Agentchats installer: links the agentchats CLI and prepares its local
# session index (SQLite + FTS5) so Claude Code and Codex sessions are
# searchable.
#
# AgentStart invokes this from scripts/install-agent-clis with --install. The
# script is fix-forward and safe to rerun: the CLI link is idempotent and the
# index refreshes incrementally once it exists.

dest_dir="$HOME/.local/bin"
repo_root=$(cd "$(dirname "$0")/.." && pwd)
timeout_runner="$repo_root/scripts/run-with-timeout"
index_timeout_seconds=1800
reader_timeout_seconds=900
installer_child_pid=

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check

Link the agentchats CLI and prepare its local session index over the
local coding-agent session stores, and build the production web reader.

Options:
  --install  Install dependencies, build the reader, link agentchats, refresh the index
  --check    Print the installation plan without changing the system
EOF
}

die() {
    printf 'Agentchats installer: %s\n' "$*" >&2
    exit 1
}

# shellcheck disable=SC2317,SC2329 # invoked by TERM/INT/HUP traps below
terminate_installer() {
    local signal=$1 status=$2

    trap - TERM INT HUP
    if [ -n "$installer_child_pid" ]; then
        kill -"$signal" "$installer_child_pid" 2>/dev/null || true
        wait "$installer_child_pid" 2>/dev/null || true
        installer_child_pid=
    fi
    exit "$status"
}

trap 'terminate_installer TERM 143' TERM
trap 'terminate_installer INT 130' INT
trap 'terminate_installer HUP 129' HUP

# A first index build can run long. Keep the subprocess bounded and track
# the wrapper so installer termination cannot leave a detached indexing
# process behind.
run_with_timeout() {
    local status

    "$timeout_runner" "$1" "$2" "${@:3}" &
    installer_child_pid=$!
    if wait "$installer_child_pid"; then
        status=0
    else
        status=$?
    fi
    installer_child_pid=
    return "$status"
}

case "${1:-}" in
    --check)
        cat <<EOF
agentchats:
  bun, Node.js 24+, and npm on PATH are required (installed by AgentStart)
  (cd $repo_root && bun install --frozen-lockfile)           # resolve the complete pinned CLI, TUI, and MCP dependencies before linking
  npm --prefix $repo_root/web ci                           # reader + pinned portless dependencies
  npm --prefix $repo_root/web run build                    # production assets; both reader steps bounded to ${reader_timeout_seconds}s
  ln -sfn $repo_root/bin/agentchats $dest_dir/agentchats      # only after dependencies and build succeed
  portless proxy setup and launchd ownership stay with AgentStart; serve never prompts for sudo
  scripts/run-with-timeout ${index_timeout_seconds}s ... agentchats index   # incremental when the index exists; safe to rerun
EOF
        exit 0
        ;;
    --install)
        ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 64
        ;;
esac
[ "$#" -eq 1 ] || {
    usage >&2
    exit 64
}

[ "$(id -u)" -ne 0 ] || die "run as the target user, not root"
command -v bun >/dev/null 2>&1 \
    || die "bun is required; install the AI stack with AgentStart first"
command -v npm >/dev/null 2>&1 || die "npm is required to install the reader"
command -v node >/dev/null 2>&1 || die "Node.js 24+ is required by portless"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
    || die "Node.js 24+ is required by portless"
[ -x "$timeout_runner" ] || die "timeout runner is missing or not executable: $timeout_runner"

mkdir -p "$dest_dir"
export PATH="$dest_dir:$PATH"

# An old TUI marker says nothing about a newly added MCP dependency. Resolve
# the complete lockfile before switching the command to this source.
printf 'Installing frozen dependencies.\n'
(cd "$repo_root" && bun install --frozen-lockfile) \
    || die "bun install --frozen-lockfile failed in $repo_root"

# Prepare the production reader before changing the command link. Runtime
# restarts only serve these assets; they do not install packages or rebuild.
printf 'Preparing the production reader.\n'
run_with_timeout "$reader_timeout_seconds" "reader dependencies" \
    npm --prefix "$repo_root/web" ci \
    || die "reader dependency install failed in $repo_root/web"
run_with_timeout "$reader_timeout_seconds" "reader build" \
    npm --prefix "$repo_root/web" run build \
    || die "reader build failed in $repo_root/web"

# The agentchats CLI is linked editable back into this checkout, the same
# contract the other agent* checkouts use for their own CLIs.
printf 'Linking the agentchats CLI.\n'
ln -sfn "$repo_root/bin/agentchats" "$dest_dir/agentchats"

# Build or refresh the index through the newly linked CLI. Incremental and
# safe to rerun; bounded so a stuck rebuild cannot hang the installer or
# leave an orphaned process behind.
printf 'Preparing the session index.\n'
run_with_timeout "$index_timeout_seconds" "agentchats index" \
    "$dest_dir/agentchats" index \
    || die "agentchats index failed; investigate with: agentchats index"

printf 'agentchats is installed; its index and production reader are ready.\n'
