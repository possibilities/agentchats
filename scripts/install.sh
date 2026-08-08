#!/bin/bash

set -euo pipefail

# Agentchats installer: installs cass (coding_agent_session_search) and
# prepares its index so Claude Code, Codex, and Pi sessions are searchable.
#
# Funk invokes this from libexec/install-ai-tools with --install. The script
# is fix-forward and safe to rerun: the binary converges on the latest
# upstream release and the index refreshes incrementally once it exists.

upstream_owner=Dicklesworthstone
upstream_repo=coding_agent_session_search
installer_url="https://raw.githubusercontent.com/$upstream_owner/$upstream_repo/main/install.sh"
dest_dir="$HOME/.local/bin"

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check

Install cass (coding agent session search) and prepare its index over the
local coding-agent session stores.

Options:
  --install  Install or upgrade cass, then build or refresh the index
  --check    Print the installation plan without changing the system
EOF
}

die() {
    printf 'Agentchats installer: %s\n' "$*" >&2
    exit 1
}

# The upstream installer resolves "latest" through the anonymous GitHub API,
# which allows 60 requests an hour per address; a few reruns exhaust that and
# fail the run over a transient external limit. Funk installs and
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

case "${1:-}" in
    --check)
        cat <<EOF
cass (coding agent session search):
  curl -fsSL $installer_url | bash -s -- --verify [--version <gh-resolved tag>]
  cass index          # incremental when healthy; cass index --full otherwise
  cass health         # must pass after indexing
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

# Prepare the index. A healthy install refreshes incrementally; a first
# install or an unhealthy one rebuilds. An incremental refresh that fails
# (for example across an upstream schema change) escalates to a full rebuild
# rather than failing the run.
if cass_healthy; then
    printf 'Refreshing the cass index incrementally.\n'
    if ! "$dest_dir/cass" index; then
        printf 'Incremental index failed; rebuilding fully.\n' >&2
        "$dest_dir/cass" index --full
    fi
else
    printf 'Building the cass index for the first time.\n'
    "$dest_dir/cass" index --full
fi

cass_healthy || die "cass is unhealthy after indexing; run: cass triage --json"

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
