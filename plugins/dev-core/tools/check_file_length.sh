#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no Python source file exceeds the configured line cap (tests excluded).
# Known exceptions are listed in the exemptions file — each must have a tracking issue.
# Exemption lines may declare a local cap: "# <N> lines" — the file must not exceed N.
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

MAX="${QG_FILE_MAX:-300}"
FIND_ROOT="${QG_FILE_ROOT:-src/}"
EXEMPT_FILE="${QG_FILE_EXEMPTIONS:-tools/file_exemptions.txt}"
QG_EXEMPT_UNIT="lines"
FAIL=0

# Shared exemption helpers (is_exempt, exempt_cap) — parameterized by $QG_EXEMPT_UNIT.
# shellcheck source=check_lib.sh
. "$LIB_DIR/check_lib.sh"

# src/ absent is not a hard error — skip with warning rather than false-green exit 0.
if [ ! -d "$FIND_ROOT" ]; then
    echo "WARN: $FIND_ROOT not found, skipping check_file_length" >&2
    exit 0
fi

# Guard: exemption paths must not contain spaces (shared helper from check_lib.sh).
assert_exempt_no_spaces

while IFS= read -r -d '' f; do
    LINES=$(wc -l < "$f")
    if is_exempt "$f"; then
        CAP=$(exempt_cap "$f")
        if [ -n "$CAP" ] && [ "$LINES" -gt "$CAP" ]; then
            echo "$f - $LINES lines (exceeds declared exemption cap of $CAP — refactor or update exemption with new count and rationale)"
            FAIL=1
        fi
        # No declared cap → back-compat full bypass; silently continue.
        continue
    fi
    if [ "$LINES" -gt "$MAX" ]; then
        echo "$f - $LINES lines (max $MAX)"
        FAIL=1
    fi
done < <(find "$FIND_ROOT" -name "*.py" -print0)

exit $FAIL
