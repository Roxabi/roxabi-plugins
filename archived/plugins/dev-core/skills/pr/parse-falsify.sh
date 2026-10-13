#!/usr/bin/env bash
# Markdown hygiene + priced SC scan + gather-state gate emitter (#417 / ADR-019).
# Sourced by gather-state.sh (no `set` — do not mutate the caller).
#
# CLI: parse-falsify.sh <evidence.md> [base-branch]
#   emits falsify_ok=… for **ungated md lint only** — ¬a gate input.
# Gate boolean is **oracle_ok** from run-falsify.sh --verify (see pf_emit_gates).
#
# Conversation-only summaries are invisible here — that is the intended fail-closed.

# shellcheck disable=SC2034  # FALSIFY_* / PRICED_OK read by gather-state.sh

# Word-bounded signals from spec SKILL (fail-closed / security / guard SCs).
PF_PRICED_SIG='fail-closed|fail[[:space:]]+closed|\bdeny\b|\brefuse\b|\breject\b|\bguard\b|\bgate\b|\bauth\b|\bauthz\b|\bsecret\b|\binject\b|\bsecurity\b'
PF_CLAIM_TAG_RE='^(fail-closed|authz|ssot)$'

# Validate claim: line in a priced YAML block (#419). Returns 0 when valid.
pf_claim_yaml_ok() {
    local yaml="${1:-}" tags tag rest
    if ! printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*claim:'; then
        return 1
    fi
    rest="$(printf '%s\n' "$yaml" | sed -n 's/^[[:space:]]*claim:[[:space:]]*//p' | head -1 | tr -d '\r')"
    [ -n "$rest" ] || return 1
    # Flow list claim: [a, b]
    if [[ "$rest" == \[* ]]; then
        rest="${rest#\[}"
        rest="${rest%\]}"
        [ -n "$rest" ] || return 1
        tags=0
        IFS=',' read -ra parts <<< "$rest"
        for tag in "${parts[@]}"; do
            tag="$(printf '%s' "$tag" | tr '[:upper:]' '[:lower:]' | sed "s/^[[:space:]]*//;s/[[:space:]]*$//;s/^['\"]//;s/['\"]$//")"
            [ -n "$tag" ] || continue
            if ! printf '%s\n' "$tag" | grep -qE "$PF_CLAIM_TAG_RE"; then
                return 1
            fi
            tags=$((tags + 1))
        done
        [ "$tags" -gt 0 ] || return 1
        return 0
    fi
    # Scalar claim: tag
    tag="$(printf '%s' "$rest" | tr '[:upper:]' '[:lower:]' | sed "s/^['\"]//;s/['\"]$//")"
    printf '%s\n' "$tag" | grep -qE "$PF_CLAIM_TAG_RE"
}

# Validate one priced YAML fence (priced/not/oracles + claim). Returns 0 when ok.
pf_priced_yaml_block_ok() {
    local yaml="${1:-}"
    printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*priced:' || return 1
    printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*not:' || return 1
    printf '%s\n' "$yaml" | grep -qE '^[[:space:]]*oracles:' || return 1
    pf_claim_yaml_ok "$yaml"
}

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

# Oracle: repo-relative regular file that is tracked or in the base…HEAD diff.
# Existence alone is not enough: '.' exists as a directory and must fail.
pf_file_is_real() {
    local f="${1:-}" base="${2:-}"
    f="${f#./}"
    case "$f" in
        ''|.|..|/) return 1 ;;
        /*) return 1 ;;
    esac
    case "/${f}/" in
        */../*) return 1 ;;
    esac
    [ -f "$f" ] || return 1
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

# Match only extracted path tokens (exact or stem). Do not glob the tests cell
# against the broke path — '.' would match every cell.
pf_row_matches_broke() {
    local tests="${1:-}" broke="${2:-}" path stem_b stem_p
    [ -n "$broke" ] || return 1
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
            '⚠ NO FALSIFY — e2e'|'⚠ NO FALSIFY - e2e'|'⚠ NO FALSIFY -- e2e')
                no_test_count=$((no_test_count + 1))
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
    # All NO TEST / NO FALSIFY and no proven row: fail-closed. An all-exempt
    # matrix must not skip the runner.
    if [ "$proven_count" -eq 0 ]; then
        FALSIFY_OK=false
        FALSIFY_REASON=no-proven-row
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
        if ! printf '%s\n' "$broke_err" | grep -qE 'AssertionError|FAIL |toThrow|Error:'; then
            FALSIFY_OK=false
            FALSIFY_REASON=no-error-token
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

# Scan spec for all ```yaml fences containing priced:. Sets PRICED_OK. Always returns 0.
pf_parse_priced() {
    local spec="${1:-}" in_yaml=0 buf=""
    PRICED_OK=true
    [ -n "$spec" ] && [ -f "$spec" ] || return 0

    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        if [[ "$line" =~ ^\`\`\`ya?ml[[:space:]]*$ ]]; then
            in_yaml=1
            buf=""
            continue
        fi
        if [[ $in_yaml -eq 1 && "$line" =~ ^\`\`\`[[:space:]]*$ ]]; then
            in_yaml=0
            if printf '%s\n' "$buf" | grep -qE '^[[:space:]]*priced:'; then
                if ! pf_priced_yaml_block_ok "$buf"; then
                    PRICED_OK=false
                    return 0
                fi
            fi
            buf=""
            continue
        fi
        if [[ $in_yaml -eq 1 ]]; then
            if [ -z "$buf" ]; then
                buf="$line"
            else
                buf="${buf}"$'\n'"${line}"
            fi
        fi
    done < "$spec"

    if [[ $in_yaml -eq 1 ]] && printf '%s\n' "$buf" | grep -qE '^[[:space:]]*priced:'; then
        if ! pf_priced_yaml_block_ok "$buf"; then
            PRICED_OK=false
        fi
    fi

    return 0
}

# Emit gather-state keys. Always returns 0.
# Gate key = oracle_ok (run-falsify --verify). falsify_ok is ¬emitted for gates.
pf_emit_gates() {
    local issue="${1:-}" base="${2:-}" spec="${3:-}" branch="${4:-}"
    local json _pf_dir rf_out ok reason

    pf_parse_priced "$spec"
    if ! pf_is_tier_s "$spec" "$branch"; then
        if [ -z "$spec" ] || [ ! -f "$spec" ]; then
            PRICED_OK=false
        fi
    fi
    echo "priced_ok=${PRICED_OK:-true}"

    if [ -z "$issue" ] || [ "$issue" = "none" ]; then
        if pf_is_tier_s "$spec" "$branch"; then
            echo "falsify_required=false"
            echo "oracle_ok=true"
            echo "oracle_reason=no-issue"
            return 0
        fi
        echo "falsify_required=true"
        echo "oracle_ok=false"
        echo "oracle_reason=no-issue"
        return 0
    fi

    if pf_is_tier_s "$spec" "$branch"; then
        echo "falsify_required=false"
        echo "oracle_ok=true"
        echo "oracle_reason=tier-s"
        return 0
    fi

    echo "falsify_required=true"
    json="artifacts/reviews/${issue}-falsify.json"
    if [ ! -f "$json" ]; then
        echo "oracle_ok=false"
        echo "oracle_reason=missing-artifact"
        return 0
    fi
    _pf_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    rf_out="$(bash "$_pf_dir/run-falsify.sh" --verify "$json" 2>/dev/null || true)"
    ok="$(printf '%s\n' "$rf_out" | sed -n 's/^oracle_ok=//p' | tail -1)"
    reason="$(printf '%s\n' "$rf_out" | sed -n 's/^oracle_reason=//p' | tail -1)"
    echo "oracle_ok=${ok:-false}"
    echo "oracle_reason=${reason:-verify-failed}"
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
