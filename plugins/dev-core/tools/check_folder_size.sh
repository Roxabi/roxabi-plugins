#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no folder contains more than 12 Python source files.
# Forces early splits and keeps folder lists graspable.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MAX=12
FAIL=0
EXEMPT_FILE="tools/folder_exemptions.txt"

is_exempt() {
    [ ! -f "$EXEMPT_FILE" ] && return 1
    grep -q "^$1[[:space:]]" "$EXEMPT_FILE"
}

while IFS= read -r -d '' d; do
    is_exempt "$d" && continue
    COUNT=$(find "$d" -maxdepth 1 -name "*.py" -type f | wc -l)
    if [ "$COUNT" -gt "$MAX" ]; then
        echo "$d - $COUNT files (max $MAX)"
        FAIL=1
    fi
done < <(find src/ -type d -print0)

exit $FAIL
