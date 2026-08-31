#!/bin/bash

set -euo pipefail

# Agentchats installer: installs cass (coding_agent_session_search) and
# prepares its index so Claude Code and Codex sessions are searchable.
#
# AgentStart invokes this from scripts/install-agent-clis with --install. The
# script is fix-forward and safe to rerun: the binary converges on the latest
# upstream release and the index refreshes incrementally once it exists.

upstream_owner=Dicklesworthstone
upstream_repo=coding_agent_session_search
installer_url="https://raw.githubusercontent.com/$upstream_owner/$upstream_repo/main/install.sh"
dest_dir="$HOME/.local/bin"
repo_root=$(cd "$(dirname "$0")/.." && pwd)
timeout_runner="$repo_root/scripts/run-with-timeout"
cass_data_dir="$HOME/Library/Application Support/com.coding-agent-search.coding-agent-search"
cass_bad_release=v0.6.26
cass_safe_release=v0.6.25
cass_search_timeout_seconds=180
cass_index_timeout_seconds=1800
installer_child_pid=

# Installation always targets the canonical stores below HOME. Refuse ambient
# overrides before a Cass command, then remove them from the child environment
# so dotenv or provider-specific roots cannot split the index boundary.
install_critical_env=(
    XDG_DATA_HOME
    XDG_CONFIG_HOME
    CASS_DATA_DIR
    CASS_DB_PATH
    CASS_HOME
    CASS_IGNORE_SOURCES_CONFIG
    CASS_EXCLUDE_PATH
    CASS_EXCLUDE_PATHS
    CASS_DAEMON_SOCKET
    CASS_AIDER_DATA_ROOT
    CASS_ANTIGRAVITY_DATA_ROOT
    CASS_CURSOR_PROJECTS_ROOT
    CASS_OPENHANDS_DATA_ROOT
    CLAUDE_CONFIG_DIR
    CLAUDE_HOME
    CODEX_HOME
    GEMINI_HOME
    GOOSE_PATH_ROOT
    GROK_HOME
    HERMES_HOME
    KIMI_CODE_HOME
    OPENCODE_STORAGE_ROOT
)
install_env_unset_args=()
for install_variable in "${install_critical_env[@]}"; do
    install_env_unset_args+=(-u "$install_variable")
done

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

# v0.6.26 was cut before upstream's GH#413 lexical-pipeline deadlock fix. On
# this machine it can park every rebuild worker at zero processed conversations
# while keeping the run lock alive forever. Keep following latest releases, but
# quarantine that one exact artifact; a later release automatically clears the
# hold without another local edit.
select_install_version() {
    local resolved_version=$1

    case "$resolved_version" in
        "$cass_bad_release"|"${cass_bad_release#v}")
            printf 'Cass %s has a known lexical rebuild deadlock; installing %s until a fixed release is published.\n' \
                "$cass_bad_release" "$cass_safe_release" >&2
            printf '%s' "$cass_safe_release"
            ;;
        '')
            printf 'Could not safely resolve the latest cass release; installing known-good %s.\n' \
                "$cass_safe_release" >&2
            printf '%s' "$cass_safe_release"
            ;;
        *)
            printf '%s' "$resolved_version"
            ;;
    esac
}

cass_path_uid() {
    case "$(uname -s)" in
        Darwin) /usr/bin/stat -f '%u' "$1" ;;
        *) /usr/bin/stat -c '%u' "$1" ;;
    esac
}

cass_path_mode() {
    case "$(uname -s)" in
        Darwin) /usr/bin/stat -f '%Lp' "$1" ;;
        *) /usr/bin/stat -c '%a' "$1" ;;
    esac
}

assert_safe_owned_directory() {
    local mode path=$1 permissions uid

    if [ ! -d "$path" ] || [ -L "$path" ]; then
        die "Cass data path component is not a real directory: $path"
    fi
    uid=$(cass_path_uid "$path") \
        || die "could not inspect Cass data path ownership: $path"
    [ "$uid" = "$(id -u)" ] \
        || die "Cass data path component is owned by another user: $path"
    mode=$(cass_path_mode "$path") \
        || die "could not inspect Cass data path permissions: $path"
    case "$mode" in
        ''|*[!0-7]*) die "Cass data path component has invalid permissions: $path" ;;
    esac
    permissions=$((8#$mode))
    [ $((permissions & 18)) -eq 0 ] \
        || die "Cass data path component is group/world writable: $path"
}

assert_cass_data_directory() {
    local component current=$HOME resolved_home

    resolved_home=$(cd "$HOME" && pwd -P) \
        || die "could not resolve the target home directory"
    [ "$resolved_home" = "$HOME" ] \
        || die "target home directory is symlinked or non-canonical: $HOME"
    assert_safe_owned_directory "$current"
    for component in Library 'Application Support' com.coding-agent-search.coding-agent-search; do
        current="$current/$component"
        assert_safe_owned_directory "$current"
    done
    [ "$current" = "$cass_data_dir" ] \
        || die "Cass data directory proof resolved an unexpected path: $current"
}

prepare_cass_data_directory() {
    local component current=$HOME resolved_home

    resolved_home=$(cd "$HOME" && pwd -P) \
        || die "could not resolve the target home directory"
    [ "$resolved_home" = "$HOME" ] \
        || die "target home directory is symlinked or non-canonical: $HOME"
    assert_safe_owned_directory "$current"
    for component in Library 'Application Support' com.coding-agent-search.coding-agent-search; do
        current="$current/$component"
        if [ ! -e "$current" ] && [ ! -L "$current" ]; then
            mkdir "$current" \
                || die "could not create Cass data path component: $current"
            chmod 700 "$current" \
                || die "could not secure Cass data path component: $current"
        fi
        assert_safe_owned_directory "$current"
    done
    [ "$current" = "$cass_data_dir" ] \
        || die "Cass data directory preparation resolved an unexpected path: $current"
}

assert_install_environment() {
    local allowed value variable

    if [ -e /.env ] || [ -L /.env ]; then
        die "refusing Cass commands while the sanitized working directory has /.env"
    fi
    for variable in "${install_critical_env[@]}"; do
        if ! /usr/bin/printenv "$variable" >/dev/null 2>&1; then
            continue
        fi
        value=${!variable}
        allowed=
        case "$variable" in
            CODEX_HOME) allowed="$HOME/.codex" ;;
            CLAUDE_CONFIG_DIR|CLAUDE_HOME) allowed="$HOME/.claude" ;;
            XDG_CONFIG_HOME) allowed="$HOME/.config" ;;
        esac
        if [ -z "$allowed" ] || [ "$value" != "$allowed" ]; then
            die "$variable would override the authoritative Cass discovery boundary"
        fi
    done
}

run_sanitized_command() {
    assert_install_environment
    (
        cd / || exit 69
        /usr/bin/env "${install_env_unset_args[@]}" HOME="$HOME" "$@"
    )
}

# Derived-index repair can run below Cass's own machine-mode budget. Keep the
# subprocess bounded and track the wrapper so installer termination cannot
# leave a detached Cass process or worker tree behind.
run_with_timeout() {
    local status

    assert_install_environment
    AGENTCHATS_TIMEOUT_WORKDIR=/ \
        "$timeout_runner" "$1" "$2" /usr/bin/env \
        "${install_env_unset_args[@]}" HOME="$HOME" "${@:3}" &
    installer_child_pid=$!
    if wait "$installer_child_pid"; then
        status=0
    else
        status=$?
    fi
    installer_child_pid=
    return "$status"
}

cass_command() {
    assert_cass_data_directory
    run_with_timeout "$cass_search_timeout_seconds" "cass ${1:-command}" \
        "$dest_dir/cass" "$@"
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

# The index is shared state: other agents' cass processes index it too, and
# cass refuses concurrent writers with exit 7 (lock/busy, retryable). An
# active rebuild by someone else is this installer's goal being accomplished
# by another hand, so wait for it instead of failing the run. Bounded: a
# large first build takes tens of minutes.
wait_for_index_turn() {
    local waited=0
    local interval=15
    local budget=1800

    while cass_command status --json 2>/dev/null \
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
    assert_cass_data_directory
    run_with_timeout "$cass_search_timeout_seconds" "cass search gate" \
        "$dest_dir/cass" search "" --robot --limit 1 >/dev/null 2>&1
}

cass_index() {
    assert_cass_data_directory
    run_with_timeout "$cass_index_timeout_seconds" "cass index" \
        "$dest_dir/cass" index "$@"
}

case "${1:-}" in
    --check)
        cat <<EOF
cass (coding agent session search):
  curl -fsSL $installer_url | bash -s -- --verify [--version <gh-resolved tag>]
  ln -sfn $repo_root/bin/agentchats $dest_dir/agentchats   # the agentchats CLI, linked editable
  (cd $repo_root && bun install --frozen-lockfile)         # the search TUI's dependencies (skipped without bun)
  prove the canonical owned HOME/Cass data boundary and sanitize connector-root overrides
  scripts/run-with-timeout ... cass index                  # incremental when serving; --full otherwise
                                                           # yields to another rebuild already in flight
  scripts/run-with-timeout ... cass search "" --robot --limit 1   # the serving gate
  report indexed conversations for the claude_code and codex session stores
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
[ -x "$timeout_runner" ] || die "timeout runner is missing or not executable: $timeout_runner"
assert_install_environment
prepare_cass_data_directory
assert_cass_data_directory

mkdir -p "$dest_dir"
export PATH="$dest_dir:$PATH"

version=$(select_install_version "$(resolve_version)")
printf 'Installing cass %s with its official installer.\n' "$version"
/usr/bin/curl -fsSL "$installer_url" \
    | DEST="$dest_dir" /bin/bash -s -- --verify --version "$version"

[ -x "$dest_dir/cass" ] || die "cass did not install to $dest_dir/cass"
run_sanitized_command "$dest_dir/cass" --version >/dev/null \
    || die "the installed cass binary could not run inside the authoritative boundary"

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
    if ! cass_index; then
        wait_for_index_turn
        if ! cass_serves_search; then
            printf 'Incremental index failed; rebuilding fully.\n' >&2
            cass_index --full
        fi
    fi
else
    printf 'Building the cass index.\n'
    cass_index --full
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
        cass_command stats --json 2>/dev/null \
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
EOF

[ "$coverage_gap" -eq 0 ] \
    || die "an existing session store indexed nothing; run: cass triage --json"

printf 'cass is installed and its index covers the local agent sessions.\n'
