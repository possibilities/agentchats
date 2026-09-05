#!/bin/bash
# Install only pre-push; preserve every unrelated Git hook and configuration.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"
if git config --get core.hooksPath >/dev/null; then
    printf 'core.hooksPath is already configured; integrate the static hook there explicitly.\n' >&2
    exit 1
fi
common=$(git rev-parse --git-common-dir)
mkdir -p "$common/hooks"
hook="$common/hooks/pre-push"
target="$root/.githooks/pre-push"
if [ -e "$hook" ] || [ -L "$hook" ]; then
    if [ -L "$hook" ] && [ "$(readlink "$hook")" = "$target" ]; then
        printf 'Static pre-push hook is already installed.\n'
        exit 0
    fi
    printf 'Existing pre-push hook retained: %s\n' "$hook" >&2
    exit 1
fi
ln -s "$target" "$hook"
printf 'Installed static pre-push hook for all worktrees: %s\n' "$target"
