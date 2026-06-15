#!/usr/bin/env bash
# Canonical source: plugins/dev-core/tools/ — do not edit project-side copies directly
# Check that no source file exceeds the configured line cap (tests excluded).
# Known exceptions are listed in the exemptions file — each must have a tracking issue.
# Exemption lines may declare a local cap: "# <N> lines" — the file must not exceed N.
# Exemptions without a declared count are back-compat: full bypass (no cap enforced).
# Configuration is read from tools/qg.conf if present (seeded from stack.yml by
# /release-setup); defaults below apply when the file is absent.
#
# SLOC mode (opt-in, back-compat):
#   QG_FILE_METRIC=sloc  — count source lines only (excludes blanks, comments, docstrings)
#   QG_FILE_EXTS        — space-separated file extensions to scan (default: "py")
#   QG_FILE_COUNTER     — counter backend: wc | radon | sloc-npm (default: wc)
# When QG_FILE_METRIC is absent or "raw", behaviour is IDENTICAL to the original script.
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
METRIC="${QG_FILE_METRIC:-raw}"
EXTS="${QG_FILE_EXTS:-py}"
COUNTER="${QG_FILE_COUNTER:-wc}"
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

# ---------------------------------------------------------------------------
# Tool availability check — exit 2 (script error) when metric=sloc but the
# required counter tool is absent. Silent fallback to raw is FORBIDDEN because
# it would silently mis-measure files (counting raw lines instead of SLOC).
# ---------------------------------------------------------------------------
check_counter_available() {
    case "$COUNTER" in
        radon)
            if ! uv run radon --version >/dev/null 2>&1; then
                echo "ERROR: metric=sloc counter=radon but radon is not available." >&2
                echo "Install with: uv add --group dev radon" >&2
                exit 2
            fi
            ;;
        sloc-npm)
            if ! command -v node >/dev/null 2>&1; then
                echo "ERROR: metric=sloc counter=sloc-npm but node is not available." >&2
                echo "node + npx are required for sloc-npm counter." >&2
                exit 2
            fi
            if ! command -v npx >/dev/null 2>&1; then
                echo "ERROR: metric=sloc counter=sloc-npm but npx is not available." >&2
                echo "node + npx are required for sloc-npm counter." >&2
                exit 2
            fi
            if ! npx -y sloc --help >/dev/null 2>&1; then
                echo "ERROR: metric=sloc counter=sloc-npm but 'npx -y sloc' failed." >&2
                echo "Ensure node + npx are available and network access is allowed for npx -y." >&2
                exit 2
            fi
            ;;
        wc)
            # wc is always available
            ;;
        *)
            echo "ERROR: unknown QG_FILE_COUNTER value: '$COUNTER' (expected: wc | radon | sloc-npm)" >&2
            exit 2
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Build the find arguments array from QG_FILE_EXTS (space-separated).
# Populates the global FIND_ARGS array.
# Single ext  → -name "*.py"
# Multiple    → \( -name "*.ts" -o -name "*.js" \)
# Portable: bash 3.2 + mawk safe; no eval.
# ---------------------------------------------------------------------------
build_find_args() {
    local _ext _first=1 _count=0
    for _ext in $EXTS; do _count=$((_count + 1)); done

    FIND_ARGS=("$FIND_ROOT" "-type" "f")

    if [ "$_count" -eq 1 ]; then
        for _ext in $EXTS; do
            FIND_ARGS+=("-name" "*.$_ext")
        done
    else
        FIND_ARGS+=("(")
        for _ext in $EXTS; do
            if [ "$_first" -eq 1 ]; then
                _first=0
                FIND_ARGS+=("-name" "*.$_ext")
            else
                FIND_ARGS+=("-o" "-name" "*.$_ext")
            fi
        done
        FIND_ARGS+=(")")
    fi
}

# ---------------------------------------------------------------------------
# Build a TAB-delimited map file "path<TAB>sloc_count" by running the counter
# ONCE over the entire tree. Efficient: O(1) tool invocations vs O(N) per file.
# ---------------------------------------------------------------------------
build_sloc_map() {
    local _map="$1"
    case "$COUNTER" in
        radon)
            # uv run radon raw -j <root> → JSON {path: {sloc:N, ...}}
            uv run radon raw -j "$FIND_ROOT" 2>/dev/null \
                | uv run python -c '
import sys, json
data = json.load(sys.stdin)
for path, metrics in data.items():
    print(path + "\t" + str(metrics.get("sloc", 0)))
' > "$_map"
            ;;
        sloc-npm)
            # Collect matching files, pass to sloc, parse per-file source count.
            local _flist
            _flist=$(mktemp)
            while IFS= read -r -d '' _f; do
                printf '%s\n' "$_f"
            done < <(find "${FIND_ARGS[@]}" -print0) > "$_flist"

            if [ ! -s "$_flist" ]; then
                rm -f "$_flist"
                return 0
            fi

            # npx -y sloc --format json <files...> → {files:[{path,stats:{source:N}}]}
            # xargs handles arbitrarily long file lists via implicit chunking.
            xargs npx -y sloc --format json < "$_flist" 2>/dev/null \
                | node -e '
var d="";
process.stdin.on("data",function(c){d+=c;});
process.stdin.on("end",function(){
    var j=JSON.parse(d);
    (j.files||[]).forEach(function(f){
        process.stdout.write(f.path+"\t"+((f.stats&&f.stats.source)||0)+"\n");
    });
});
' > "$_map"
            rm -f "$_flist"
            ;;
    esac
}

# Look up a file path in the sloc map (exact first-field match, TAB separator).
lookup_sloc() {
    local _map="$1" _path="$2"
    P="$_path" awk -F'\t' '$1 == ENVIRON["P"] { print $2; exit }' "$_map"
}

# ---------------------------------------------------------------------------
# Main gate loop
# ---------------------------------------------------------------------------

if [ "$METRIC" = "sloc" ]; then
    check_counter_available

    # Build find args once (used both for map construction and the gate loop)
    build_find_args

    SLOC_MAP=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f $SLOC_MAP" EXIT

    build_sloc_map "$SLOC_MAP"

    while IFS= read -r -d '' f; do
        if [ "$COUNTER" = "wc" ]; then
            LINES=$(wc -l < "$f")
        else
            LINES=$(lookup_sloc "$SLOC_MAP" "$f")
            if [ -z "$LINES" ]; then
                echo "WARN: $f not found in SLOC map (counter=$COUNTER); skipping" >&2
                continue
            fi
        fi

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
    done < <(find "${FIND_ARGS[@]}" -print0)

    rm -f "$SLOC_MAP"

else
    # raw mode (default): wc -l on *.py — IDENTICAL to original behaviour.
    # QG_FILE_EXTS and QG_FILE_COUNTER are ignored in raw mode.
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
fi

exit $FAIL
