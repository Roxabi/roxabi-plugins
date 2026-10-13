#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no folder contains more than the configured cap of Python source files.
# Forces early splits and keeps folder lists graspable.
# Exemption lines may declare a local cap: "# <N> files" — the folder must not exceed N.
# Exemptions without a declared count are back-compat: full bypass (no cap enforced).
# Configuration is read from tools/qg.conf if present (seeded from stack.yml by
# /release-setup); defaults below apply when the file is absent.
#
# Opt-out (explicit only — a missing directory is never a pass):
#   QG_FOLDER_SIZE_DISABLE=1   this repository is not subject to the folder-size gate.
#   Accepted values: 1, true, yes (case-insensitive). Unset, empty, or 0 = gate applies.
#   Set it in the environment, or in tools/qg.conf so a non-empty export still wins:
#     : "${QG_FOLDER_SIZE_DISABLE:=1}"
#   To point the gate at another tree instead, set QG_FOLDER_ROOT to an existing directory.
#   Without either, a missing QG_FOLDER_ROOT (default src/) is a hard failure that names
#   the expected path and this opt-out.
#
# --self-test  Prove the gate can fail. Builds a violation in a temp git repo, re-invokes
#   this script, and exits 0 only if that invocation exits 1. Never touches the work tree.
set -euo pipefail

# Resolve the lib dir relative to this script (beside it: canonical plugins/dev-core/tools/
# or the project-side tools/ copy) BEFORE cd changes the working directory.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prove the comparison can fail. Isolated temp git repo; the child cds there, so the
# real work tree and its qg.conf are never read or written.
self_test() {
    local tmp rc=0
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' RETURN
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "$tmp" init -q
    mkdir -p "$tmp/src"
    printf 'x\n' > "$tmp/src/a.py"
    printf 'x\n' > "$tmp/src/b.py"
    printf 'x\n' > "$tmp/src/c.py"
    (
        cd "$tmp" && \
        env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u QG_FOLDER_SIZE_DISABLE \
            QG_FOLDER_MAX=2 \
            QG_FOLDER_ROOT="$tmp/src" \
            QG_FOLDER_EXEMPTIONS="$tmp/no-exemptions.txt" \
            "$LIB_DIR/check_folder_size.sh"
    ) || rc=$?
    if [ "$rc" -ne 1 ]; then
        echo "ERROR: check_folder_size --self-test: expected exit 1 on a folder over the cap, got $rc" >&2
        exit 1
    fi
    exit 0
}

for _arg in "$@"; do
    if [ "$_arg" = "--self-test" ]; then
        self_test
    fi
done


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

# Missing scan root is a hard failure unless the operator opted out. See header.
require_scan_root QG_FOLDER_SIZE_DISABLE QG_FOLDER_ROOT check_folder_size

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
