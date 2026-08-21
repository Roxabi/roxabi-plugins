#!/usr/bin/env bash
# Mechanical oracle for /pr falsify + priced rails, and /code-review tester skip.
# Sourced by gather-state.sh (no `set` — do not mutate the caller).
# CLI: parse-falsify.sh <evidence-file> [base-branch]
#   emits falsify_ok=true|false and falsify_reason=<token>
#   missing file / parse fail → falsify_ok=false (fail-closed). Always exit 0.
#
# Conversation-only summaries are invisible here — that is the intended fail-closed.

# shellcheck disable=SC2034  # FALSIFY_* / PRICED_OK read by gather-state.sh

# Word-bounded signals from spec SKILL (fail-closed / security / guard SCs).
PF_PRICED_SIG='fail-closed|fail[[:space:]]+closed|\bdeny\b|\brefuse\b|\breject\b|\bguard\b|\bgate\b|\bauth\b|\bauthz\b|\bsecret\b|\binject\b|\bsecurity\b'

pf_is_tier_s() {
    local spec="${1:-}" branch="${2:-}"
    local prefix
    if [ -n "$spec" ] && [ -f "$spec" ]; then
        if awk '
            /^---/ { n++; next }
            n == 1 && /^tier:[[:space:]]*(S|XS)[[:space:]]*$/ { found = 1 }
            n >= 2 { exit }
            END { exit !found }
        ' "$spec"; then
            return 0
        fi
        return 1
    fi
    # No spec: S-shaped branch (chore/docs/ci) or no conventional issue branch.
    prefix="${branch%%/*}"
    case "$prefix" in
        chore|docs|ci) return 0 ;;
        *) return 1 ;;
    esac
}

pf_file_is_real() {
    local f="${1:-}" base="${2:-}"
    [ -n "$f" ] || return 1
    [ -e "$f" ] && return 0
    git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && return 0
    if [ -n "$base" ]; then
        git diff "origin/${base}...HEAD" --name-only 2>/dev/null \
            | grep -Fx -- "$f" >/dev/null && return 0
    fi
    return 1
}

# Stem a path so `foo.test.ts` / `__tests__/foo.ts` match source `foo.ts`.
pf_stem() {
    local p="${1:-}"
    p="${p#./}"
    p="${p//\/__tests__\//\/}"
    p="${p%.ts}"; p="${p%.tsx}"; p="${p%.js}"; p="${p%.jsx}"
    p="${p%.mjs}"; p="${p%.cjs}"; p="${p%.py}"; p="${p%.sh}"; p="${p%.md}"
    p="${p%.test}"; p="${p%.spec}"
    printf '%s' "$p"
}

pf_row_matches_broke() {
    local tests="${1:-}" broke="${2:-}" path stem_b stem_p
    [ -n "$broke" ] || return 1
    case "$tests" in
        *"$broke"*) return 0 ;;
    esac
    stem_b="$(pf_stem "$broke")"
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        [ "$path" = "$broke" ] && return 0
        stem_p="$(pf_stem "$path")"
        [ -n "$stem_p" ] && [ "$stem_p" = "$stem_b" ] && return 0
    done < <(printf '%s\n' "$tests" | grep -oE '[A-Za-z0-9_./-]+\.[A-Za-z0-9.]+' || true)
    return 1
}

# Parse persisted matrix + evidence. Sets FALSIFY_OK / FALSIFY_REASON. Always returns 0.
pf_parse_file() {
    local file="${1:-}" base="${2:-}"
    local body matrix_heading evidence_heading
    local row sc tests status reason
    local line broke_file broke_err
    local proven_count=0 no_test_count=0 row_count=0
    local broke_files="" unmatched
    FALSIFY_OK=true
    FALSIFY_REASON=ok

    if [ -z "$file" ] || [ ! -f "$file" ]; then
        FALSIFY_OK=false
        FALSIFY_REASON=missing-artifact
        return 0
    fi

    body="$(tr -d '\r' < "$file")"

    matrix_heading=false
    evidence_heading=false
    printf '%s\n' "$body" | grep -qE '^##[[:space:]]+SC' && matrix_heading=true
    printf '%s\n' "$body" | grep -qE '^##[[:space:]]+Falsification Evidence' && evidence_heading=true

    if [ "$matrix_heading" != true ]; then
        FALSIFY_OK=false
        FALSIFY_REASON=missing-matrix
        return 0
    fi
    if [ "$evidence_heading" != true ]; then
        FALSIFY_OK=false
        FALSIFY_REASON=missing-evidence
        return 0
    fi

    while IFS= read -r row; do
        [ -n "$row" ] || continue
        sc="$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2 }')"
        tests="$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); print $3 }')"
        status="$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4); print $4 }')"
        [ -n "$sc" ] || continue
        case "$sc" in
            SC|-*|"") continue ;;
        esac
        row_count=$((row_count + 1))

        case "$status" in
            '✓ proven')
                proven_count=$((proven_count + 1))
                case "$tests" in
                    ''|'—'|'-'|'n/a'|'N/A')
                        FALSIFY_OK=false
                        FALSIFY_REASON=proven-unmapped
                        return 0
                        ;;
                esac
                ;;
            '⚠ NO TEST — '*|'⚠ NO TEST - '*|'⚠ NO TEST -- '*)
                reason="$status"
                reason="${reason#⚠ NO TEST — }"
                reason="${reason#⚠ NO TEST -- }"
                reason="${reason#⚠ NO TEST - }"
                reason="$(printf '%s' "$reason" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
                case "$reason" in
                    infra-not-wired|prompt-logic-only|ui-manual-only|out-of-scope)
                        no_test_count=$((no_test_count + 1))
                        ;;
                    *)
                        FALSIFY_OK=false
                        FALSIFY_REASON=no-test-enum
                        return 0
                        ;;
                esac
                ;;
            '⏳ not run')
                FALSIFY_OK=false
                FALSIFY_REASON=pending-row
                return 0
                ;;
            '✗ failed')
                FALSIFY_OK=false
                FALSIFY_REASON=failed-row
                return 0
                ;;
            '')
                FALSIFY_OK=false
                FALSIFY_REASON=missing-status
                return 0
                ;;
            *)
                FALSIFY_OK=false
                FALSIFY_REASON=bad-status
                return 0
                ;;
        esac
    done < <(printf '%s\n' "$body" | awk '
        BEGIN { in_m = 0 }
        /^##[[:space:]]+SC/ { in_m = 1; next }
        in_m && /^##[[:space:]]/ { in_m = 0 }
        in_m && /^\|/ {
            if ($0 ~ /SC[[:space:]]*\|[[:space:]]*Test/) next
            if ($0 ~ /^\|[[:space:]]*[-:| ]+$/) next
            print
        }
    ')

    if [ "$row_count" -eq 0 ]; then
        FALSIFY_OK=false
        FALSIFY_REASON=missing-matrix-rows
        return 0
    fi

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! printf '%s\n' "$line" | grep -qE '^[[:space:]]*broke[[:space:]]+'; then
            continue
        fi
        broke_file="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*broke[[:space:]]+//; s/[[:space:]]+(→|->)[[:space:]].*$//')"
        broke_err="$(printf '%s\n' "$line" | sed -E 's/^.*[[:space:]](→|->)[[:space:]]+//')"
        if [ -z "$broke_file" ]; then
            FALSIFY_OK=false
            FALSIFY_REASON=empty-broke-file
            return 0
        fi
        case "$broke_file$broke_err" in
            *'{error'*|*'{source'*|*'source A'*)
                FALSIFY_OK=false
                FALSIFY_REASON=placeholder
                return 0
                ;;
        esac
        if [ -z "$broke_err" ]; then
            FALSIFY_OK=false
            FALSIFY_REASON=empty-error
            return 0
        fi
        if ! pf_file_is_real "$broke_file" "$base"; then
            FALSIFY_OK=false
            FALSIFY_REASON=unreal-file
            return 0
        fi
        broke_files="${broke_files}${broke_file}"$'\n'
    done < <(printf '%s\n' "$body" | awk '
        BEGIN { in_e = 0 }
        /^##[[:space:]]+Falsification Evidence/ { in_e = 1; next }
        in_e && /^##[[:space:]]/ { in_e = 0 }
        in_e { print }
    ')

    if [ "$proven_count" -gt 0 ]; then
        while IFS= read -r row; do
            [ -n "$row" ] || continue
            tests="$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3); print $3 }')"
            status="$(printf '%s\n' "$row" | awk -F'|' '{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4); print $4 }')"
            [ "$status" = '✓ proven' ] || continue
            unmatched=true
            while IFS= read -r broke_file; do
                [ -n "$broke_file" ] || continue
                if pf_row_matches_broke "$tests" "$broke_file"; then
                    unmatched=false
                    break
                fi
            done < <(printf '%s' "$broke_files")
            if [ "$unmatched" = true ]; then
                FALSIFY_OK=false
                FALSIFY_REASON=proven-unmatched
                return 0
            fi
        done < <(printf '%s\n' "$body" | awk '
            BEGIN { in_m = 0 }
            /^##[[:space:]]+SC/ { in_m = 1; next }
            in_m && /^##[[:space:]]/ { in_m = 0 }
            in_m && /^\|/ {
                if ($0 ~ /SC[[:space:]]*\|[[:space:]]*Test/) next
                if ($0 ~ /^\|[[:space:]]*[-:| ]+$/) next
                print
            }
        ')
    fi

    return 0
}

# Scan spec Success Criteria checkboxes. Sets PRICED_OK. Always returns 0.
pf_parse_priced() {
    local spec="${1:-}" section items item first yaml
    PRICED_OK=true
    [ -n "$spec" ] && [ -f "$spec" ] || return 0

    section="$(awk '
        /^##[[:space:]]+Success Criteria/ { p = 1; next }
        p && /^##[[:space:]]/ { exit }
        p { print }
    ' "$spec" | tr -d '\r')"
    [ -n "$section" ] || return 0

    items="$(printf '%s\n' "$section" | awk '
        /^[[:space:]]*-[[:space:]]*\[[ xX]\]/ {
            if (buf != "") printf "%s\036", buf
            buf = $0
            next
        }
        { if (buf != "") buf = buf "\n" $0 }
        END { if (buf != "") printf "%s", buf }
    ')"
    [ -n "$items" ] || return 0

    while IFS= read -r -d $'\036' item || [ -n "${item:-}" ]; do
        [ -n "$item" ] || continue
        first="$(printf '%s\n' "$item" | head -1)"
        if ! printf '%s\n' "$first" | grep -qiE "$PF_PRICED_SIG"; then
            continue
        fi
        yaml="$(printf '%s\n' "$item" | awk '
            /^```ya?ml/ { p = 1; next }
            /^```[[:space:]]*$/ { if (p) { p = 0; next } }
            p { print }
        ')"
        if [ -z "$yaml" ]; then
            yaml="$(printf '%s\n' "$item" | awk '
                /^```/ { if (!p) { p = 1; next } else { p = 0; next } }
                p { print }
            ')"
        fi
        if ! printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*priced:'; then
            PRICED_OK=false
            return 0
        fi
        if ! printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*not:'; then
            PRICED_OK=false
            return 0
        fi
        if ! printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*oracles:'; then
            PRICED_OK=false
            return 0
        fi
        item=""
    done < <(printf '%s' "$items")

    return 0
}

# Emit gather-state keys. Always returns 0.
pf_emit_gates() {
    local issue="${1:-}" base="${2:-}" spec="${3:-}" branch="${4:-}"
    local ev

    pf_parse_priced "$spec"
    echo "priced_ok=${PRICED_OK:-true}"

    if [ -z "$issue" ] || [ "$issue" = "none" ]; then
        echo "falsify_required=false"
        echo "falsify_ok=true"
        echo "falsify_reason=no-issue"
        return 0
    fi

    if pf_is_tier_s "$spec" "$branch"; then
        echo "falsify_required=false"
        echo "falsify_ok=true"
        echo "falsify_reason=tier-s"
        return 0
    fi

    echo "falsify_required=true"
    ev="artifacts/reviews/${issue}-falsify.md"
    if [ ! -f "$ev" ]; then
        echo "falsify_ok=false"
        echo "falsify_reason=missing-artifact"
        return 0
    fi
    pf_parse_file "$ev" "$base"
    echo "falsify_ok=${FALSIFY_OK:-false}"
    echo "falsify_reason=${FALSIFY_REASON:-missing-artifact}"
    return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    set -euo pipefail
    _pf_file="${1:-}"
    _pf_base="${2:-}"
    if [ -z "$_pf_base" ]; then
        _pf_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        # shellcheck source=../shared/lib.sh
        . "$_pf_dir/../shared/lib.sh"
        _pf_base="$(detect_base_branch)"
    fi
    pf_parse_file "$_pf_file" "$_pf_base"
    echo "falsify_ok=${FALSIFY_OK:-false}"
    echo "falsify_reason=${FALSIFY_REASON:-missing-artifact}"
fi
