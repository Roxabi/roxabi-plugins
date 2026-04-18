#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no Python source file exceeds 300 lines (tests excluded).
# Known exceptions are listed in tools/file_exemptions.txt — each must have a tracking issue.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MAX=300
FAIL=0
EXEMPT_FILE="tools/file_exemptions.txt"

is_exempt() {
    [ ! -f "$EXEMPT_FILE" ] && return 1
    grep -q "^$1[[:space:]]" "$EXEMPT_FILE"
}

while IFS= read -r -d '' f; do
    is_exempt "$f" && continue
    LINES=$(wc -l < "$f")
    if [ "$LINES" -gt "$MAX" ]; then
        echo "$f - $LINES lines (max $MAX)"
        FAIL=1
    fi
done < <(find src/ -name "*.py" -print0)

exit $FAIL
