#!/bin/bash

set -euo pipefail

# Agentchats installer: installs cass (coding_agent_session_search) and
# prepares its index so Claude Code, Codex, and Pi sessions are searchable.
#
# AgentStart invokes this from scripts/install-agent-clis with --install. The
# script is fix-forward and safe to rerun: the binary converges on the latest
# upstream release and the index refreshes incrementally once it exists.

upstream_owner=Dicklesworthstone
upstream_repo=coding_agent_session_search
installer_url="https://raw.githubusercontent.com/$upstream_owner/$upstream_repo/main/install.sh"
dest_dir="$HOME/.local/bin"
repo_root=$(cd "$(dirname "$0")/.." && pwd)

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check

Install cass (coding agent session search), link the agentchats CLI, and
prepare the index over the local coding-agent session stores.

Options:
  --install  Install or upgrade cass, link agentchats, refresh the index
  --check    Print the installation plan without changing the system
EOF
}

die() {
    printf 'Agentchats installer: %s\n' "$*" >&2
    exit 1
}

# The upstream installer resolves "latest" through the anonymous GitHub API,
# which allows 60 requests an hour per address; a few reruns exhaust that and
# fail the run over a transient external limit. The machine installs and
# authenticates gh (5000 an hour), so resolve the tag here and hand it over.
# With --version supplied the installer skips the API entirely.
resolve_version() {
    local version=

    if command -v gh >/dev/null 2>&1; then
        version=$(
            gh release view --repo "$upstream_owner/$upstream_repo" \
                --json tagName --jq '.tagName' 2>/dev/null
        ) || version=
    fi
    printf '%s' "$version"
}

cass_healthy() {
    "$dest_dir/cass" health >/dev/null 2>&1
}

# The index is shared state: other agents' cass processes index it too, and
# cass refuses concurrent writers with exit 7 (lock/busy, retryable). An
# active rebuild by someone else is this installer's goal being accomplished
# by another hand, so wait for it instead of failing the run. Bounded: a
# large first build takes tens of minutes.
wait_for_index_turn() {
    local waited=0
    local interval=15
    local budget=1800

    while "$dest_dir/cass" status --json 2>/dev/null \
        | /usr/bin/jq -e '.rebuild.active == true' >/dev/null 2>&1; do
        if [ "$waited" -eq 0 ]; then
            printf 'Another cass process is rebuilding the index; waiting for it.\n'
        fi
        [ "$waited" -lt "$budget" ] \
            || die "an index rebuild has been active for over $((budget / 60)) minutes; investigate with: cass status --json"
        sleep "$interval"
        waited=$((waited + interval))
    done
}

# Search is the installer's promise, so search is the gate. Health probes
# can report transient states under concurrent cass activity that a served
# search disproves; a genuinely broken index fails this probe too.
cass_serves_search() {
    "$dest_dir/cass" search "" --robot --limit 1 >/dev/null 2>&1
}

case "${1:-}" in
    --check)
        cat <<EOF
cass (coding agent session search):
  curl -fsSL $installer_url | bash -s -- --verify [--version <gh-resolved tag>]
  ln -sfn $repo_root/bin/agentchats $dest_dir/agentchats   # the agentchats CLI, linked editable
  (cd $repo_root && bun install --frozen-lockfile)         # the search TUI's dependencies (skipped without bun)
  cass index          # incremental when serving; cass index --full otherwise
                      # yields to any rebuild another process has in flight
  cass search "" --robot --limit 1   # the gate: search must serve after indexing
  report indexed conversations for the claude_code, codex, and pi session stores
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
command -v curl >/dev/null 2>&1 || die "curl is required"

mkdir -p "$dest_dir"
export PATH="$dest_dir:$PATH"

version=$(resolve_version)
if [ -n "$version" ]; then
    printf 'Installing cass %s with its official installer.\n' "$version"
    /usr/bin/curl -fsSL "$installer_url" \
        | DEST="$dest_dir" /bin/bash -s -- --verify --version "$version"
else
    printf 'Could not resolve the latest cass release with gh; letting the installer choose.\n' >&2
    /usr/bin/curl -fsSL "$installer_url" \
        | DEST="$dest_dir" /bin/bash -s -- --verify
fi

[ -x "$dest_dir/cass" ] || die "cass did not install to $dest_dir/cass"

# The agentchats CLI is linked editable back into this checkout, the same
# contract the other agent* checkouts use for their own CLIs.
printf 'Linking the agentchats CLI.\n'
ln -sfn "$repo_root/bin/agentchats" "$dest_dir/agentchats"

# The search TUI runs from this checkout under bun; its dependencies are the
# checkout's node_modules. A machine without bun keeps `agentchats state`
# and skips the TUI — bun arrives with AgentStart's stack, not here.
if command -v bun >/dev/null 2>&1; then
    printf 'Installing the search TUI dependencies.\n'
    (cd "$repo_root" && bun install --frozen-lockfile >/dev/null) \
        || die "bun install failed in $repo_root"
else
    printf 'bun is not installed; agentchats search stays unavailable until it is.\n' >&2
fi

# Prepare the index. A serving install refreshes incrementally; a first
# install or a broken one rebuilds fully. An incremental refresh that fails
# (for example across an upstream schema change) escalates to a full rebuild
# rather than failing the run, and every step yields to a rebuild another
# process already has in flight.
wait_for_index_turn
if cass_serves_search; then
    printf 'Refreshing the cass index incrementally.\n'
    if ! "$dest_dir/cass" index; then
        wait_for_index_turn
        if ! cass_serves_search; then
            printf 'Incremental index failed; rebuilding fully.\n' >&2
            "$dest_dir/cass" index --full
        fi
    fi
else
    printf 'Building the cass index.\n'
    "$dest_dir/cass" index --full
fi
wait_for_index_turn

cass_serves_search \
    || die "cass cannot serve a search after indexing; run: cass triage --json"

# Prove the agents this machine uses are actually searchable. A session store
# that exists on disk but indexed nothing is the failure this installer is
# for; a store that does not exist yet is a machine that has not run that
# agent, and its connector stays ready.
printf 'Verifying agent session coverage.\n'
coverage_gap=0
while IFS='|' read -r agent store; do
    store_path="${store/#\~/$HOME}"
    count=$(
        "$dest_dir/cass" stats --json 2>/dev/null \
            | /usr/bin/jq -r --arg agent "$agent" \
                '[.by_agent[] | select(.agent == $agent) | .count] | add // 0' \
                2>/dev/null
    ) || count=
    count=${count:-0}
    if [ -d "$store_path" ] && [ -n "$(ls -A "$store_path" 2>/dev/null)" ]; then
        if [ "$count" -gt 0 ] 2>/dev/null; then
            printf '  %s: %s conversations indexed.\n' "$agent" "$count"
        else
            printf '  %s: session store %s is non-empty but nothing indexed.\n' \
                "$agent" "$store" >&2
            coverage_gap=1
        fi
    else
        printf '  %s: no session store at %s yet; connector ready.\n' \
            "$agent" "$store"
    fi
done <<'EOF'
claude_code|~/.claude/projects
codex|~/.codex/sessions
pi_agent|~/.pi/agent/sessions
EOF

[ "$coverage_gap" -eq 0 ] \
    || die "an existing session store indexed nothing; run: cass triage --json"

printf 'cass is installed and its index covers the local agent sessions.\n'
