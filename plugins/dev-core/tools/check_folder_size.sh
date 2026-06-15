#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no folder contains more than the configured cap of Python source files.
# Forces early splits and keeps folder lists graspable.
# Exemption lines may declare a local cap: "# <N> files" — the folder must not exceed N.
# Exemptions without a declared count are back-compat: full bypass (no cap enforced).
# Configuration is read from tools/qg.conf if present (seeded from stack.yml by
# /release-setup); defaults below apply when the file is absent.
set -euo pipefail

# Resolve the lib dir relative to this script (beside it: canonical plugins/dev-core/tools/
# or the project-side tools/ copy) BEFORE cd changes the working directory.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$(git rev-parse --show-toplevel)"

# Source generated config (safe: file is owned by /release-setup, not user-editable).
# shellcheck disable=SC1091
[ -f tools/qg.conf ] && . tools/qg.conf

MAX="${QG_FOLDER_MAX:-12}"
FIND_ROOT="${QG_FOLDER_ROOT:-src/}"
EXEMPT_FILE="${QG_FOLDER_EXEMPTIONS:-tools/folder_exemptions.txt}"
QG_EXEMPT_UNIT="files"
FAIL=0

# Shared exemption helpers (is_exempt, exempt_cap) — parameterized by $QG_EXEMPT_UNIT.
# shellcheck source=check_lib.sh
. "$LIB_DIR/check_lib.sh"

if [ ! -d "$FIND_ROOT" ]; then
    echo "WARN: $FIND_ROOT not found, skipping check_folder_size" >&2
    exit 0
fi

# Guard: exemption paths must not contain spaces (shared helper from check_lib.sh).
assert_exempt_no_spaces

while IFS= read -r -d '' d; do
    # Portable NUL-delimited count — works on macOS bash 3.2 (no mapfile/readarray).
    COUNT=0
    while IFS= read -r -d '' _; do
        COUNT=$((COUNT + 1))
    done < <(find "$d" -maxdepth 1 -name "*.py" -type f -print0)
    if is_exempt "$d"; then
        CAP=$(exempt_cap "$d")
        if [ -n "$CAP" ] && [ "$COUNT" -gt "$CAP" ]; then
            echo "$d - $COUNT files (exceeds declared exemption cap of $CAP — refactor or update exemption with new count and rationale)"
            FAIL=1
        fi
        # No declared cap → back-compat full bypass; silently continue.
        continue
    fi
    if [ "$COUNT" -gt "$MAX" ]; then
        echo "$d - $COUNT files (max $MAX)"
        FAIL=1
    fi
done < <(find "$FIND_ROOT" -type d -print0)

exit $FAIL
