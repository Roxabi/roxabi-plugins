#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no folder contains more than the configured cap of Python source files.
# Forces early splits and keeps folder lists graspable.
# Configuration is read from tools/qg.conf if present (seeded from stack.yml by
# /release-setup); defaults below apply when the file is absent.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Source generated config (safe: file is owned by /release-setup, not user-editable).
# shellcheck disable=SC1091
[ -f tools/qg.conf ] && . tools/qg.conf

MAX="${QG_FOLDER_MAX:-12}"
FIND_ROOT="${QG_FOLDER_ROOT:-src/}"
EXEMPT_FILE="${QG_FOLDER_EXEMPTIONS:-tools/folder_exemptions.txt}"
FAIL=0

if [ ! -d "$FIND_ROOT" ]; then
    echo "WARN: $FIND_ROOT not found, skipping check_folder_size" >&2
    exit 0
fi

is_exempt() {
    [ ! -f "$EXEMPT_FILE" ] && return 1
    # Exact match on the first whitespace-delimited field — no regex, no escaping,
    # left-anchored (awk field split) so a path substring elsewhere on the line
    # cannot cause a false positive. Exemption format: '<path> <issue-url>'.
    awk -v p="$1" '$1 == p { found = 1 } END { exit !found }' "$EXEMPT_FILE"
}

while IFS= read -r -d '' d; do
    is_exempt "$d" && continue
    # Portable NUL-delimited count — works on macOS bash 3.2 (no mapfile/readarray).
    COUNT=0
    while IFS= read -r -d '' _; do
        COUNT=$((COUNT + 1))
    done < <(find "$d" -maxdepth 1 -name "*.py" -type f -print0)
    if [ "$COUNT" -gt "$MAX" ]; then
        echo "$d - $COUNT files (max $MAX)"
        FAIL=1
    fi
done < <(find "$FIND_ROOT" -type d -print0)

exit $FAIL
