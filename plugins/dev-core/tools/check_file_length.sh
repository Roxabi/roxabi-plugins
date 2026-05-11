#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no Python source file exceeds the configured line cap (tests excluded).
# Known exceptions are listed in the exemptions file — each must have a tracking issue.
# Exemption lines may declare a local cap: "# <N> lines" — the file must not exceed N.
# Exemptions without a declared count are back-compat: full bypass (no cap enforced).
# Configuration is read from tools/qg.conf if present (seeded from stack.yml by
# /release-setup); defaults below apply when the file is absent.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Source generated config (safe: file is owned by /release-setup, not user-editable).
# shellcheck disable=SC1091
[ -f tools/qg.conf ] && . tools/qg.conf

MAX="${QG_FILE_MAX:-300}"
FIND_ROOT="${QG_FILE_ROOT:-src/}"
EXEMPT_FILE="${QG_FILE_EXEMPTIONS:-tools/file_exemptions.txt}"
FAIL=0

# src/ absent is not a hard error — skip with warning rather than false-green exit 0.
if [ ! -d "$FIND_ROOT" ]; then
    echo "WARN: $FIND_ROOT not found, skipping check_file_length" >&2
    exit 0
fi

is_exempt() {
    [ ! -f "$EXEMPT_FILE" ] && return 1
    # Exact match on the first whitespace-delimited field — no regex, no escaping,
    # left-anchored (awk field split) so a path substring elsewhere on the line
    # cannot cause a false positive. Exemption format: '<path> <issue-url>'.
    # Paths must not contain spaces — field splitting would break the match.
    # ENVIRON avoids awk's -v escape processing (backslash sequences in path → corrupted match).
    P="$1" awk '$1 == ENVIRON["P"] { found = 1 } END { exit !found }' "$EXEMPT_FILE"
}

# Parse the declared cap from the matching exemption line.
# Looks for "# <N> lines" anywhere after the path field.
# Returns the integer N, or empty string if not present (back-compat: full bypass).
# POSIX-portable: uses two-arg match() + substr() instead of gawk's three-arg match()
# so the script works on mawk (Ubuntu/Pop!_OS default /usr/bin/awk).
exempt_cap() {
    [ ! -f "$EXEMPT_FILE" ] && return 0
    P="$1" awk '
        $1 == ENVIRON["P"] {
            if (match($0, /# *[0-9]+ *lines/)) {
                s = substr($0, RSTART, RLENGTH)
                if (match(s, /[0-9]+/)) print substr(s, RSTART, RLENGTH)
            }
            exit
        }
    ' "$EXEMPT_FILE"
}

# Guard: exemption paths must not contain spaces.
# A space-embedded path produces NF>2 with $2 being a path fragment (not a comment),
# while the new exemption format "path  # N lines — issue desc..." has $2 == "#".
# Skips comment lines (#) to avoid false-positives on scaffold-generated headers.
if [ -f "$EXEMPT_FILE" ] && awk '/^[[:space:]]*#/ { next } NF > 2 && $2 !~ /^#/ { found=1 } END { exit !found }' "$EXEMPT_FILE"; then
    echo "ERROR: $EXEMPT_FILE: exemption path contains spaces — paths with spaces are not supported" >&2
    exit 1
fi

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
