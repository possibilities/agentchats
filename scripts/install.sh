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
installer_child_pid=

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check

Link the agentchats CLI and prepare its local session index over the
local coding-agent session stores.

Options:
  --install  Link agentchats, install its dependencies, refresh the index
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
  bun on PATH is required (installed by AgentStart)
  ln -sfn $repo_root/bin/agentchats $dest_dir/agentchats   # the agentchats CLI, linked editable
  (cd $repo_root && bun install)                           # only when node_modules/@opentui/core is missing
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
[ -x "$timeout_runner" ] || die "timeout runner is missing or not executable: $timeout_runner"

mkdir -p "$dest_dir"
export PATH="$dest_dir:$PATH"

# The agentchats CLI is linked editable back into this checkout, the same
# contract the other agent* checkouts use for their own CLIs.
printf 'Linking the agentchats CLI.\n'
ln -sfn "$repo_root/bin/agentchats" "$dest_dir/agentchats"

# Dependencies live in this checkout's node_modules; @opentui/core is the
# search TUI's marker package. Skip the install when it is already present
# so a rerun stays fast.
if [ ! -d "$repo_root/node_modules/@opentui/core" ]; then
    printf 'Installing dependencies.\n'
    (cd "$repo_root" && bun install) \
        || die "bun install failed in $repo_root"
fi

# Build or refresh the index through the newly linked CLI. Incremental and
# safe to rerun; bounded so a stuck rebuild cannot hang the installer or
# leave an orphaned process behind.
printf 'Preparing the session index.\n'
run_with_timeout "$index_timeout_seconds" "agentchats index" \
    "$dest_dir/agentchats" index \
    || die "agentchats index failed; investigate with: agentchats index"

printf 'agentchats is installed and its index is ready.\n'
