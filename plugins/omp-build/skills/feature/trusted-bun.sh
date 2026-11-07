#!/usr/bin/env bash
# Keep the target cwd while selecting only the installed Bun startup configuration.
set -Eeuo pipefail
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_SOURCE" == */* ]]; then SCRIPT_DIR="${SCRIPT_SOURCE%/*}"; else SCRIPT_DIR=.; fi
SCRIPT_DIR="$(cd -P -- "$SCRIPT_DIR" && pwd -P)"
exec bun --config="$SCRIPT_DIR/trusted-bunfig.toml" --tsconfig-override="$SCRIPT_DIR/trusted-tsconfig.json" --no-env-file "$@"
