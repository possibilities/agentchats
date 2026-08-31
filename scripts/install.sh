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
raw_mirror_retirement_script="$repo_root/scripts/retire-pi-raw-mirror.mjs"
cass_orphan_retirement_script="$repo_root/scripts/delete-retired-pi-cass-orphan.mjs"
cass_data_dir="$HOME/Library/Application Support/com.coding-agent-search.coding-agent-search"
cass_lock_path="$cass_data_dir/index-run.lock"
flock_bin=/opt/homebrew/bin/flock
timeout_runner="$repo_root/scripts/run-with-timeout"
cass_bad_release=v0.6.26
cass_safe_release=v0.6.25
cass_search_timeout_seconds=180
cass_index_timeout_seconds=1800
cass_lock_held=0
installer_child_pid=

retirement_critical_env=(
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
    PI_CODING_AGENT_DIR
    PI_SESSIONS_DIR
)
retirement_env_unset_args=()
for retirement_variable in "${retirement_critical_env[@]}"; do
    retirement_env_unset_args+=(-u "$retirement_variable")
done

usage() {
    cat <<'EOF'
Usage: scripts/install.sh --install | --check | --retirement-proof

Install cass (coding agent session search), link the agentchats CLI, and
prepare the index over the local coding-agent session stores.

Options:
  --install  Install or upgrade cass, link agentchats, refresh the index
  --check    Print the installation plan without changing the system
  --retirement-proof  Atomically prove the retired connector is absent from Cass
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

# Cass normally has its own bounded machine-mode behavior, but derived-index
# repair can run below the search command before that budget engages. Bound the
# child process here as an installer contract so a bad release cannot park all
# of AgentStart indefinitely. TERM gives cass a chance to close its database;
# KILL is only the five-second fallback for an already wedged process.
run_with_timeout() {
    local status

    assert_retirement_environment
    AGENTCHATS_TIMEOUT_WORKDIR=/ \
        "$timeout_runner" "$1" "$2" /usr/bin/env \
        "${retirement_env_unset_args[@]}" HOME="$HOME" "${@:3}" &
    installer_child_pid=$!
    if wait "$installer_child_pid"; then
        status=0
    else
        status=$?
    fi
    installer_child_pid=
    return "$status"
}

cass_healthy() {
    cass_command health >/dev/null 2>&1
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

cass_path_nlink() {
    case "$(uname -s)" in
        Darwin) /usr/bin/stat -f '%l' "$1" ;;
        *) /usr/bin/stat -c '%h' "$1" ;;
    esac
}

assert_safe_owned_directory() {
    local mode path=$1 permissions uid

    [ -d "$path" ] && [ ! -L "$path" ] \
        || die "Cass data path component is not a real directory: $path"
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

assert_cass_database_path() {
    local candidate database="$cass_data_dir/agent_search.db" mode nlink permissions uid

    assert_cass_data_directory
    if [ ! -e "$database" ]; then
        [ ! -L "$database" ] || die "refusing symlinked Cass archive database"
        for candidate in "$database"?*; do
            if [ -e "$candidate" ] || [ -L "$candidate" ]; then
                die "refusing orphaned Cass database sidecar without its main database: $candidate"
            fi
        done
        return 1
    fi
    [ -f "$database" ] && [ ! -L "$database" ] \
        || die "Cass archive database is not a regular owned file"
    uid=$(cass_path_uid "$database") \
        || die "could not inspect Cass archive database ownership"
    [ "$uid" = "$(id -u)" ] \
        || die "Cass archive database is owned by another user"
    mode=$(cass_path_mode "$database") \
        || die "could not inspect Cass archive database permissions"
    case "$mode" in
        ''|*[!0-7]*) die "Cass archive database has invalid permissions" ;;
    esac
    permissions=$((8#$mode))
    [ $((permissions & 18)) -eq 0 ] \
        || die "Cass archive database is group/world writable"
    nlink=$(cass_path_nlink "$database") \
        || die "could not inspect Cass archive database link count"
    case "$nlink" in
        ''|*[!0-9]*) die "Cass archive database has an invalid link count" ;;
    esac
    [ "$nlink" -eq 1 ] \
        || die "Cass archive database has hard links"

    # Cass 0.6.25's archive on this machine uses SQLite's WAL/SHM pair,
    # frankensqlite's namespace pair, and its WAL certificate pair. Direct
    # SQLite access must refuse every other prefix sibling and prove every
    # accepted sidecar independently; merely proving the main DB is not
    # enough because SQLite opens these names implicitly.
    for candidate in "$database"?*; do
        if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
            continue
        fi
        case "$candidate" in
            "$database-fsqlite-ns-gate"|\
            "$database-fsqlite-ns-use"|\
            "$database-shm"|\
            "$database-wal"|\
            "$database-wal-cert"|\
            "$database-wal-cert-head") ;;
            *) die "refusing unknown Cass archive database sidecar: $candidate" ;;
        esac
        [ -f "$candidate" ] && [ ! -L "$candidate" ] \
            || die "Cass archive database sidecar is not a regular owned file: $candidate"
        uid=$(cass_path_uid "$candidate") \
            || die "could not inspect Cass archive database sidecar ownership: $candidate"
        [ "$uid" = "$(id -u)" ] \
            || die "Cass archive database sidecar is owned by another user: $candidate"
        mode=$(cass_path_mode "$candidate") \
            || die "could not inspect Cass archive database sidecar permissions: $candidate"
        case "$mode" in
            ''|*[!0-7]*) die "Cass archive database sidecar has invalid permissions: $candidate" ;;
        esac
        permissions=$((8#$mode))
        [ $((permissions & 18)) -eq 0 ] \
            || die "Cass archive database sidecar is group/world writable: $candidate"
        nlink=$(cass_path_nlink "$candidate") \
            || die "could not inspect Cass archive database sidecar link count: $candidate"
        case "$nlink" in
            ''|*[!0-9]*) die "Cass archive database sidecar has an invalid link count: $candidate" ;;
        esac
        [ "$nlink" -eq 1 ] \
            || die "Cass archive database sidecar has hard links: $candidate"
    done
    return 0
}

cass_command() {
    assert_cass_data_directory
    run_with_timeout "$cass_search_timeout_seconds" "cass ${1:-command}" \
        "$dest_dir/cass" "$@"
}

acquire_cass_writer_lock() {
    prepare_cass_data_directory
    assert_cass_data_directory
    [ ! -L "$cass_lock_path" ] \
        || die "refusing symlinked Cass writer lock: $cass_lock_path"
    exec 9>>"$cass_lock_path"
    "$flock_bin" -x -w "$cass_index_timeout_seconds" 9 \
        || die "could not acquire Cass's writer lock within $cass_index_timeout_seconds seconds"
    cass_lock_held=1
    assert_cass_writer_lock
}

release_cass_writer_lock() {
    [ "$cass_lock_held" -eq 1 ] || return 0
    "$flock_bin" -u 9 || die "could not release Cass's writer lock"
    exec 9>&-
    cass_lock_held=0
}

release_cass_writer_lock_on_exit() {
    [ "$cass_lock_held" -eq 1 ] || return 0
    "$flock_bin" -u 9 >/dev/null 2>&1 || true
    exec 9>&-
    cass_lock_held=0
}

assert_cass_writer_lock() {
    assert_cass_data_directory
    AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$flock_bin" \
        run_sanitized_command node "$raw_mirror_retirement_script" --assert-lock >/dev/null \
        || die "the inherited descriptor does not prove Cass's live writer lock"
}

apply_raw_mirror_retirement_locked() {
    assert_cass_data_directory
    AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$flock_bin" \
        run_sanitized_command node "$raw_mirror_retirement_script" --apply --cass-bin "$dest_dir/cass" >/dev/null \
        || die "raw-mirror retirement refused the locked live state"
}

retirement_receipt_pending() {
    local status
    status=$(run_sanitized_command node "$raw_mirror_retirement_script" --pending-status) \
        || return 1
    printf '%s\n' "$status" \
        | /usr/bin/jq -er '.pending | if . == true then 1 elif . == false then 0 else error("invalid pending flag") end'
}

mark_retirement_pending_locked() {
    AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$flock_bin" \
        run_sanitized_command node "$raw_mirror_retirement_script" --mark-pending \
        | /usr/bin/jq -e '.pending == true and (.changed | type == "boolean")' >/dev/null \
        || die "could not durably mark the retired connector rebuild as pending"
    assert_cass_writer_lock
}

clear_retirement_pending_locked() {
    AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$flock_bin" \
        run_sanitized_command node "$raw_mirror_retirement_script" --clear-pending \
        | /usr/bin/jq -e '.pending == false and (.changed | type == "boolean")' >/dev/null \
        || die "could not clear the retired connector rebuild receipt"
    assert_cass_writer_lock
}

assert_retirement_environment() {
    local allowed value variable

    [ ! -e /.env ] && [ ! -L /.env ] \
        || die "refusing Cass commands while the sanitized working directory has /.env"
    for variable in "${retirement_critical_env[@]}"; do
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
        [ -n "$allowed" ] && [ "$value" = "$allowed" ] \
            || die "$variable would override the authoritative retirement discovery boundary"
    done
}

run_sanitized_command() {
    assert_retirement_environment
    (
        cd / || exit 69
        /usr/bin/env "${retirement_env_unset_args[@]}" HOME="$HOME" "$@"
    )
}

terminate_installer() {
    local signal=$1 status=$2

    trap - TERM INT HUP
    if [ -n "$installer_child_pid" ]; then
        kill -"$signal" "$installer_child_pid" 2>/dev/null || true
        wait "$installer_child_pid" 2>/dev/null || true
        installer_child_pid=
    fi
    # A timed Cass child is fully reaped before this can release fd 9.
    release_cass_writer_lock_on_exit
    exit "$status"
}

# This retirement is deliberately narrower than Cass's general semantic
# repair surface. A lexical rebuild has a complete replacement contract; an
# in-progress or published vector tier can retain provider-derived chunks and
# has its own resumable publisher. Refuse before the first archive mutation
# unless every semantic surface is proved absent, and reprove the same facts
# before clearing the durable retry receipt.
assert_no_semantic_retirement_state_locked() {
    local archive_receipt component database_present=0 status

    assert_cass_writer_lock
    for component in vector_index semantic semantic-cache; do
        if [ -e "$cass_data_dir/$component" ] || [ -L "$cass_data_dir/$component" ]; then
            die "refusing retired-connector mutation while Cass semantic state exists: $cass_data_dir/$component"
        fi
    done

    if assert_cass_database_path; then
        database_present=1
    fi

    assert_cass_data_directory
    status=$(
        run_with_timeout "$cass_search_timeout_seconds" "Cass semantic retirement proof" \
            "$dest_dir/cass" status --json
    ) || die "could not inspect Cass semantic state before retired-connector mutation"
    printf '%s\n' "$status" \
        | /usr/bin/jq -e '
            .rebuild.active == false
            and .semantic.fast_tier.present == false
            and .semantic.quality_tier.present == false
            and .semantic.backlog.pending_work == false
            and .semantic.checkpoint.active == false
            and .daemon_runtime.state == "not-running"
            and .daemon_runtime.observation.run_lock_present == false
            and .daemon_runtime.observation.socket_present == false
            and .daemon_runtime.observation.socket_connectable == false
        ' >/dev/null \
        || die "semantic tiers, backlog, checkpoint, daemon, or rebuild state could retain retired connector data"

    if [ "$database_present" -eq 1 ]; then
        archive_receipt=$(cass_archive_helper_locked inspect) \
            || die "could not inspect the exact Cass archive before retired-connector mutation"
        printf '%s\n' "$archive_receipt" \
            | /usr/bin/jq -e '.active_embedding_jobs == 0' >/dev/null \
            || die "Cass has active embedding jobs that could republish retired connector data"
    fi
    assert_cass_writer_lock
}

cass_archive_helper_locked() {
    local mode=$1 receipt

    assert_cass_writer_lock
    assert_cass_database_path \
        || die "Cass archive database disappeared before exact archive proof"
    receipt=$(
        AGENTCHATS_RETIREMENT_LOCK_FD=9 FLOCK_BIN="$flock_bin" \
            run_sanitized_command node "$cass_orphan_retirement_script" \
            --database "$cass_data_dir/agent_search.db" \
            --cass-bin "$dest_dir/cass" \
            --mode "$mode"
    ) || return 1
    printf '%s\n' "$receipt" \
        | /usr/bin/jq -e '
            .schema_version == 20
            and (.deleted | type == "number" and floor == . and . >= 0 and . <= 1)
            and .quick_check == "ok"
            and ([
                .agents,
                .conversations,
                .snippets,
                .conversation_tags,
                .conversation_tail_state,
                .conversation_external_lookup,
                .conversation_external_tail_lookup,
                .daily_stats,
                .token_daily_stats,
                .message_metrics,
                .usage_hourly,
                .usage_daily,
                .usage_models_daily,
                .token_usage,
                .foreign_key_violations,
                .referential_inconsistencies
            ] | all(type == "number" and floor == . and . >= 0))
        ' >/dev/null \
        || die "Cass 0.6.25 archive helper returned an invalid receipt"
    assert_cass_writer_lock
    printf '%s\n' "$receipt"
}

cleanup_cass_0625_orphan_agent_locked() {
    local receipt

    receipt=$(cass_archive_helper_locked cleanup) \
        || die "Cass 0.6.25 exact orphan cleanup refused the rebuilt archive"
    printf '%s\n' "$receipt" \
        | /usr/bin/jq -e '
            .agents == 0
            and .conversations == 0
            and .daily_stats == 0
            and .token_daily_stats == 0
            and .message_metrics == 0
            and .usage_hourly == 0
            and .usage_daily == 0
            and .usage_models_daily == 0
            and .token_usage == 0
            and .foreign_key_violations == 0
            and .referential_inconsistencies == 0
        ' >/dev/null \
        || die "Cass 0.6.25 cleanup receipt retained retired archive state"
}

assert_cass_archive_retirement_locked() {
    local receipt

    assert_cass_writer_lock
    if ! assert_cass_database_path; then
        return 0
    fi
    receipt=$(cass_archive_helper_locked proof) \
        || die "could not prove the exact Cass 0.6.25 retirement archive"
    printf '%s\n' "$receipt" \
        | /usr/bin/jq -e '([
            .agents,
            .conversations,
            .snippets,
            .conversation_tags,
            .conversation_tail_state,
            .conversation_external_lookup,
            .conversation_external_tail_lookup,
            .daily_stats,
            .token_daily_stats,
            .message_metrics,
            .usage_hourly,
            .usage_daily,
            .usage_models_daily,
            .token_usage,
            .foreign_key_violations,
            .referential_inconsistencies
        ] | all(. == 0))' >/dev/null \
        || die "Cass archive still contains retired connector state"
    assert_cass_writer_lock
}

prove_cass_archive_retirement_locked() {
    local receipt

    receipt=$(cass_archive_helper_locked proof) \
        || die "could not prove the exact Cass 0.6.25 retirement archive"
    printf '%s\n' "$receipt"
}

retirement_completion_proof() {
    local archive_receipt excluded_agents_json pi_indexed_count pi_search_json
    local raw_retirement_plan receipt_pending search_hits

    acquire_cass_writer_lock
    assert_no_semantic_retirement_state_locked
    receipt_pending=$(retirement_receipt_pending) \
        || die "could not inspect the retired connector rebuild receipt"
    [ "$receipt_pending" -eq 0 ] \
        || die "the retired connector rebuild receipt is still pending"

    pi_indexed_count=$(
        cass_command stats --json 2>/dev/null \
            | /usr/bin/jq -er '[.by_agent[] | select(.agent == "pi_agent") | .count] | add // 0'
    ) || die "could not prove retired connector archive statistics"
    [ "$pi_indexed_count" -eq 0 ] \
        || die "retired connector archive statistics remain: $pi_indexed_count"
    archive_receipt=$(prove_cass_archive_retirement_locked)

    pi_search_json=$(
        run_with_timeout "$cass_search_timeout_seconds" "retired connector completion search" \
            "$dest_dir/cass" search "" --robot --agent pi_agent --limit 1
    ) || die "could not prove retired connector search results"
    printf '%s\n' "$pi_search_json" \
        | /usr/bin/jq -e '
            .count == 0
            and (.hits | type == "array" and length == 0)
        ' >/dev/null \
        || die "retired connector completion search returned hits"
    search_hits=$(printf '%s\n' "$pi_search_json" | /usr/bin/jq -c '.hits') \
        || die "could not preserve the exact retired-connector hits array"

    raw_retirement_plan=$(run_sanitized_command node "$raw_mirror_retirement_script" --dry-run) \
        || die "could not prove retired raw-mirror state"
    printf '%s\n' "$raw_retirement_plan" \
        | /usr/bin/jq -e '
            .pending_transaction == false
            and .manifest_count == 0
            and .blob_count == 0
            and .bytes == 0
        ' >/dev/null \
        || die "retired raw-mirror state remains"
    assert_cass_writer_lock

    # sources.toml is outside the database lock. Read Cass's supported config
    # surface last, after every archive/search/raw check, so connector_disabled
    # cannot be a stale observation from before the proof.
    excluded_agents_json=$(cass_command sources agents list --json) \
        || die "could not reprove Cass connector exclusions after all retirement checks"
    printf '%s\n' "$excluded_agents_json" \
        | /usr/bin/jq -e '.disabled_agents | index("pi_agent") != null' >/dev/null \
        || die "the retired Cass connector is not persistently excluded"
    assert_cass_writer_lock

    /usr/bin/jq -n \
        --arg retirement pi_agent \
        --argjson archive "$archive_receipt" \
        --argjson search_hits "$search_hits" \
        '{
            schema_version: 1,
            retirement: $retirement,
            complete: true,
            connector_disabled: true,
            archive_rows: 0,
            archive: {
                schema_version: $archive.schema_version,
                agents: $archive.agents,
                conversations: $archive.conversations,
                snippets: $archive.snippets,
                conversation_tags: $archive.conversation_tags,
                conversation_tail_state: $archive.conversation_tail_state,
                conversation_external_lookup: $archive.conversation_external_lookup,
                conversation_external_tail_lookup: $archive.conversation_external_tail_lookup,
                daily_stats: $archive.daily_stats,
                token_daily_stats: $archive.token_daily_stats,
                message_metrics: $archive.message_metrics,
                usage_hourly: $archive.usage_hourly,
                usage_daily: $archive.usage_daily,
                usage_models_daily: $archive.usage_models_daily,
                token_usage: $archive.token_usage,
                foreign_key_violations: $archive.foreign_key_violations,
                referential_inconsistencies: $archive.referential_inconsistencies,
                quick_check: $archive.quick_check
            },
            search_hit_count: 0,
            search_hits: $search_hits,
            raw_manifests: 0,
            raw_blobs: 0,
            rebuild_pending: false,
            semantic_state: false,
            daemon_running: false
        }'
    release_cass_writer_lock
}

trap release_cass_writer_lock_on_exit EXIT
trap 'terminate_installer TERM 143' TERM
trap 'terminate_installer INT 130' INT
trap 'terminate_installer HUP 129' HUP

case "${1:-}" in
    --check)
        assert_retirement_environment
        command -v node >/dev/null 2>&1 \
            || die "node is required to inspect raw-mirror retirement state"
        check_raw_retirement_plan=$(run_sanitized_command node "$raw_mirror_retirement_script" --dry-run) \
            || die "could not inspect raw-mirror retirement state"
        check_retirement_receipt=$(run_sanitized_command node "$raw_mirror_retirement_script" --pending-status) \
            || die "could not inspect the retired connector rebuild receipt"
        cat <<EOF
cass (coding agent session search):
  curl -fsSL $installer_url | bash -s -- --verify [--version <gh-resolved tag>]
  ln -sfn $repo_root/bin/agentchats $dest_dir/agentchats   # the agentchats CLI, linked editable
  (cd $repo_root && bun install --frozen-lockfile)         # the search TUI's dependencies (skipped without bun)
  acquire Cass's real index-run.lock with Homebrew flock
  prove fd 9 is the exact owned live lock inode before and after Cass mutations
  cass sources agents exclude pi_agent                    # only when absent, archive-bearing, or state-unknown
  node $cass_orphan_retirement_script --database ...      # exact Cass 0.6.25 zero-conversation orphan only
  node $raw_mirror_retirement_script --apply              # same lock; quarantine + full Cass verification
  cass index          # incremental when serving; cass index --full otherwise
                      # a detected retirement state forces a full rebuild
  refuse retirement unless all Cass semantic tiers, jobs, checkpoints, and paths are absent
  persist a retry receipt, then force a lexical full rebuild on every interrupted rerun
                      # yields to any rebuild another process has in flight
  cass search "" --robot --limit 1   # the gate: search must serve after indexing
  prove the retired connector has zero archive rows, search hits, and raw captures
  report indexed conversations for the claude_code and codex session stores
  observed raw-mirror retirement: $check_raw_retirement_plan
  observed rebuild receipt: $check_retirement_receipt
EOF
        exit 0
        ;;
    --install)
        ;;
    --retirement-proof)
        [ "$#" -eq 1 ] || {
            usage >&2
            exit 64
        }
        assert_retirement_environment
        command -v node >/dev/null 2>&1 \
            || die "node is required for raw-mirror retirement proof"
        [ -x /usr/bin/sqlite3 ] \
            || die "/usr/bin/sqlite3 is required for archive retirement proof"
        [ -x /usr/bin/jq ] || die "/usr/bin/jq is required for retirement proof"
        [ -x "$flock_bin" ] \
            || die "$flock_bin is required for Cass-compatible retirement locking"
        [ -x "$timeout_runner" ] \
            || die "$timeout_runner is required for bounded Cass commands"
        [ -x "$dest_dir/cass" ] || die "Cass is not installed at $dest_dir/cass"
        retirement_completion_proof
        exit 0
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

assert_retirement_environment
[ "$(id -u)" -ne 0 ] || die "run as the target user, not root"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v node >/dev/null 2>&1 || die "node is required for raw-mirror retirement"
[ -x /usr/bin/sqlite3 ] || die "/usr/bin/sqlite3 is required for semantic retirement proofs"
[ -x "$flock_bin" ] || die "$flock_bin is required for Cass-compatible retirement locking"
[ -x "$timeout_runner" ] || die "$timeout_runner is required for bounded Cass commands"
[ -x "$cass_orphan_retirement_script" ] \
    || die "$cass_orphan_retirement_script is required for pinned Cass cleanup"

mkdir -p "$dest_dir"
export PATH="$dest_dir:$PATH"

version=$(select_install_version "$(resolve_version)")
printf 'Installing cass %s with its official installer.\n' "$version"
/usr/bin/curl -fsSL "$installer_url" \
    | DEST="$dest_dir" /bin/bash -s -- --verify --version "$version"

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

# Establish the filesystem authority boundary before the first Cass command,
# lock open, or database probe. Every later mutation boundary reproves it.
prepare_cass_data_directory
assert_cass_data_directory

# Retire the old connector through cass's supported ownership boundary before
# its source store is removed. Exclusion is persistent and purges canonical
# archive rows; the narrow helper separately removes only provenance-proven raw
# captures after scanning every manifest for shared blobs. Detect state before
# either mutation so the first retirement run forces every derived asset to be
# rebuilt, while later convergence remains incremental.
wait_for_index_turn
raw_retirement_plan=$(run_sanitized_command node "$raw_mirror_retirement_script" --dry-run) \
    || die "could not prove raw-mirror retirement targets"
raw_retirement_manifest_count=$(
    printf '%s\n' "$raw_retirement_plan" \
        | /usr/bin/jq -er '.manifest_count | select(type == "number" and floor == . and . >= 0)'
) || die "raw-mirror retirement dry-run returned an invalid manifest count"
raw_retirement_pending=$(
    printf '%s\n' "$raw_retirement_plan" \
        | /usr/bin/jq -er '.pending_transaction | if . == true then 1 elif . == false then 0 else error("invalid pending flag") end'
) || die "raw-mirror retirement dry-run returned an invalid pending-transaction flag"
retirement_receipt_was_pending=$(retirement_receipt_pending) \
    || die "could not inspect the retired connector rebuild receipt"
pi_stats_known=1
if ! pi_indexed_count=$(
    cass_command stats --json 2>/dev/null \
        | /usr/bin/jq -er '[.by_agent[] | select(.agent == "pi_agent") | .count] | add // 0'
); then
    # A first or broken index has no trustworthy archive count yet. Treat the
    # state as retirement-bearing and let the full rebuild establish truth.
    pi_indexed_count=0
    pi_stats_known=0
fi

pi_search_known=1
assert_cass_data_directory
if pi_search_json=$(
    run_with_timeout "$cass_search_timeout_seconds" "pre-clean retired connector search" \
        "$dest_dir/cass" search "" --robot --agent pi_agent --limit 1 2>/dev/null
); then
    if ! pi_search_count=$(
        printf '%s\n' "$pi_search_json" \
            | /usr/bin/jq -er '.count | select(type == "number" and floor == . and . >= 0)'
    ); then
        pi_search_count=0
        pi_search_known=0
    fi
else
    pi_search_count=0
    pi_search_known=0
fi

excluded_agents_json=$(cass_command sources agents list --json) \
    || die "could not read cass connector exclusions"
pi_already_excluded=0
if printf '%s\n' "$excluded_agents_json" \
    | /usr/bin/jq -e '.disabled_agents | index("pi_agent") != null' >/dev/null; then
    pi_already_excluded=1
fi

pi_store_has_sessions=0
if [ -d "$HOME/.pi/agent/sessions" ] \
    && [ -n "$(ls -A "$HOME/.pi/agent/sessions" 2>/dev/null)" ]; then
    pi_store_has_sessions=1
fi

pi_retirement_state=0
if [ "$raw_retirement_manifest_count" -gt 0 ] \
    || [ "$raw_retirement_pending" -eq 1 ] \
    || [ "$retirement_receipt_was_pending" -eq 1 ] \
    || [ "$pi_indexed_count" -gt 0 ] \
    || [ "$pi_stats_known" -eq 0 ] \
    || [ "$pi_search_count" -gt 0 ] \
    || [ "$pi_search_known" -eq 0 ] \
    || [ "$pi_already_excluded" -eq 0 ] \
    || [ "$pi_store_has_sessions" -eq 1 ]; then
    pi_retirement_state=1
fi

# Cass's connector exclusion mutates the canonical database and rebuilds the
# lexical index without taking index-run.lock itself. Hold the exact lock inode
# across exclusion, raw-capture claim, both live-manifest rescans, full Cass
# verification, and the durable deleting transition.
acquire_cass_writer_lock
locked_excluded_agents_json=$(cass_command sources agents list --json) \
    || die "could not read Cass connector exclusions while holding the writer lock"
locked_pi_already_excluded=0
if printf '%s\n' "$locked_excluded_agents_json" \
    | /usr/bin/jq -e '.disabled_agents | index("pi_agent") != null' >/dev/null; then
    locked_pi_already_excluded=1
fi
locked_pi_stats_known=1
if ! locked_pi_indexed_count=$(
    cass_command stats --json 2>/dev/null \
        | /usr/bin/jq -er '[.by_agent[] | select(.agent == "pi_agent") | .count] | add // 0'
); then
    locked_pi_indexed_count=0
    locked_pi_stats_known=0
fi
locked_archive_target_count=0
if assert_cass_database_path; then
    locked_archive_receipt=$(cass_archive_helper_locked inspect) \
        || die "could not inspect Cass's exact archive while holding the writer lock"
    locked_archive_target_count=$(
        printf '%s\n' "$locked_archive_receipt" \
            | /usr/bin/jq -er '[
                .agents,
                .conversations,
                .daily_stats,
                .token_daily_stats,
                .message_metrics,
                .usage_hourly,
                .usage_daily,
                .usage_models_daily,
                .token_usage
            ] | add'
    ) || die "Cass archive inspection returned invalid retirement counts"
fi

locked_raw_retirement_plan=$(run_sanitized_command node "$raw_mirror_retirement_script" --dry-run) \
    || die "could not reprove raw-mirror retirement targets while holding the writer lock"
locked_raw_retirement_manifest_count=$(
    printf '%s\n' "$locked_raw_retirement_plan" \
        | /usr/bin/jq -er '.manifest_count | select(type == "number" and floor == . and . >= 0)'
) || die "locked raw-mirror retirement plan returned an invalid manifest count"
locked_raw_retirement_pending=$(
    printf '%s\n' "$locked_raw_retirement_plan" \
        | /usr/bin/jq -er '.pending_transaction | if . == true then 1 elif . == false then 0 else error("invalid pending flag") end'
) || die "locked raw-mirror retirement plan returned an invalid pending flag"
locked_retirement_receipt_pending=$(retirement_receipt_pending) \
    || die "could not reprove the retired connector rebuild receipt while holding the writer lock"

if [ "$pi_retirement_state" -eq 1 ] \
    || [ "$locked_raw_retirement_manifest_count" -gt 0 ] \
    || [ "$locked_raw_retirement_pending" -eq 1 ] \
    || [ "$locked_retirement_receipt_pending" -eq 1 ] \
    || [ "$locked_pi_already_excluded" -eq 0 ] \
    || [ "$locked_archive_target_count" -gt 0 ] \
    || [ "$locked_pi_indexed_count" -gt 0 ] \
    || [ "$locked_pi_stats_known" -eq 0 ]; then
    pi_retirement_state=1
    assert_no_semantic_retirement_state_locked
    mark_retirement_pending_locked
fi

if [ "$locked_pi_already_excluded" -eq 0 ] \
    || [ "$locked_archive_target_count" -gt 0 ] \
    || [ "$locked_pi_indexed_count" -gt 0 ] \
    || [ "$locked_pi_stats_known" -eq 0 ]; then
    printf 'Excluding the retired cass connector and purging its archive rows.\n'
    assert_cass_data_directory
    run_with_timeout "$cass_index_timeout_seconds" "cass connector exclusion" \
        "$dest_dir/cass" sources agents exclude pi_agent >/dev/null \
        || die "could not persistently exclude and purge the retired cass connector"
else
    printf 'The retired cass connector is already excluded with no archive rows.\n'
fi
assert_cass_writer_lock
assert_no_semantic_retirement_state_locked

# Keep the raw-mirror manifests in place until the post-rebuild archive helper
# consumes their validated conversation ids as provenance for any stale
# no-FK tail-cache rows. The raw payloads are retired after that helper and
# before the final convergence proof below.
release_cass_writer_lock

# Prepare the index. A serving install refreshes incrementally; a first,
# broken, or retirement-bearing install rebuilds fully. An incremental refresh
# that fails (for example across an upstream schema change) escalates to a full
# rebuild rather than failing the run, and every step yields to a rebuild
# another process already has in flight.
if [ "$pi_retirement_state" -eq 1 ]; then
    printf 'Retirement state was present; rebuilding the cass index from active connectors.\n'
    cass_index --full --force-rebuild
elif cass_serves_search; then
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

# A connector scan that began before exclusion could have completed while the
# first cleanup ran. Apply the same ownership proof once more after indexing,
# then require all three Cass surfaces to be empty for the retired connector.
acquire_cass_writer_lock
assert_no_semantic_retirement_state_locked
cleanup_cass_0625_orphan_agent_locked
assert_cass_writer_lock
printf 'Removing ownership-proven retired raw-mirror captures.\n'
apply_raw_mirror_retirement_locked
assert_cass_writer_lock
archive_retirement_receipt=$(prove_cass_archive_retirement_locked)

cass_serves_search \
    || die "cass cannot serve a search after indexing; run: cass triage --json"

pi_indexed_count=$(
    cass_command stats --json 2>/dev/null \
        | /usr/bin/jq -er '[.by_agent[] | select(.agent == "pi_agent") | .count] | add // 0'
) || die "could not verify retired connector archive rows"
[ "$pi_indexed_count" -eq 0 ] \
    || die "retired connector archive rows remain after purge: $pi_indexed_count"
printf '%s\n' "$archive_retirement_receipt" \
    | /usr/bin/jq -e '[
        .agents,
        .conversations,
        .snippets,
        .conversation_tags,
        .conversation_tail_state,
        .conversation_external_lookup,
        .conversation_external_tail_lookup,
        .daily_stats,
        .token_daily_stats,
        .message_metrics,
        .usage_hourly,
        .usage_daily,
        .usage_models_daily,
        .token_usage,
        .foreign_key_violations,
        .referential_inconsistencies
    ] | all(. == 0)' >/dev/null \
    || die "exact archive retirement receipt was invalidated"

assert_cass_data_directory
pi_search_json=$(
    run_with_timeout "$cass_search_timeout_seconds" "retired connector search proof" \
        "$dest_dir/cass" search "" --robot --agent pi_agent --limit 1
) || die "could not verify retired connector search results"
printf '%s\n' "$pi_search_json" \
    | /usr/bin/jq -e '
        .count == 0
        and (.hits | type == "array" and length == 0)
    ' >/dev/null \
    || die "retired connector search results remain after purge"

raw_retirement_plan=$(run_sanitized_command node "$raw_mirror_retirement_script" --dry-run) \
    || die "could not verify raw-mirror retirement"
printf '%s\n' "$raw_retirement_plan" \
    | /usr/bin/jq -e '.pending_transaction == false and .manifest_count == 0 and .blob_count == 0' >/dev/null \
    || die "retired raw-mirror captures remain after cleanup"
if [ "$pi_retirement_state" -eq 1 ]; then
    assert_no_semantic_retirement_state_locked
    clear_retirement_pending_locked
fi

# sources.toml is not protected by index-run.lock. Re-read Cass's supported
# config surface only after every archive, search, raw, and receipt check.
excluded_agents_json=$(cass_command sources agents list --json) \
    || die "could not reprove cass connector exclusions after convergence"
printf '%s\n' "$excluded_agents_json" \
    | /usr/bin/jq -e '.disabled_agents | index("pi_agent") != null' >/dev/null \
    || die "the retired cass connector is not persistently excluded"
assert_cass_writer_lock
release_cass_writer_lock
printf '  retired connector: zero archive rows, search hits, and raw captures.\n'

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
