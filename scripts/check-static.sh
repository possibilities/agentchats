#!/bin/bash
# Run via python3 .githooks/pre-push --check for the shared lock and deadline.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts=(scripts/install.sh scripts/run-with-timeout bin/agentchats scripts/check-static.sh scripts/install-hooks.sh)
for script in "${scripts[@]}"; do
    bash -n "$script"
done
shellcheck --severity=warning --shell=bash "${scripts[@]}"
printf 'Static checks passed.\n'
