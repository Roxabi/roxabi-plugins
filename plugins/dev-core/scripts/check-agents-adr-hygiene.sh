#!/usr/bin/env bash
# ADR hygiene gate. Two independent check families, two independent defaults.
#
#   A. AGENTS.md bare-ref heuristic — prefer domain-doc links over bare ADR-NNN
#      as operational law. Linked forms ([ADR-0002](docs/.../adr/...)) are OK.
#      Default mode: warn. It is a style judgement; a regex cannot settle it.
#
#   B. ADR frontmatter contract — every ADR carries status + normative + date,
#      superseded ADRs name their replacement, and at most one ADR is axial.
#      Default mode: fail. It is machine-checkable, and a gate that cannot turn
#      red is not a gate.
#
#      "At most one" is the invariant: two axial ADRs name two axes of
#      decomposition, which is a contradiction the corpus can never hold.
#      "Exactly one" is a maturity assertion — a repo that has not yet run
#      `/R-adr --axial` has zero, and failing it for not having decided yet
#      makes the gate red on arrival in the situation it exists to help. So
#      the zero case is opt-in, via AGENTS_ADR_AXIAL_MODE.
#
# Contract reference: dev-core/skills/adr/references/adr-template.md
#
# Env:
#   AGENTS_ADR_MODE           warn|fail      (family A, default warn)
#   AGENTS_ADR_CONTRACT_MODE  warn|fail      (family B, default fail)
#   AGENTS_ADR_AXIAL_MODE     off|warn|fail  (require a declared axis, default off)
#   AGENTS_ADR_FILE           file scanned by family A (default AGENTS.md)
#   AGENTS_ADR_DIR            ADR root   (default docs/architecture/adr)
#   AGENTS_ADR_ROOT           repo root  (default: git toplevel, else $PWD)
#   AGENTS_ADR_DOC            optional pointer doc quoted in family A output
#
# EXIT: 0 when no family in fail mode reported a violation; 1 otherwise.
set -euo pipefail

ROOT="${AGENTS_ADR_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT"

MODE="${AGENTS_ADR_MODE:-warn}"
CONTRACT_MODE="${AGENTS_ADR_CONTRACT_MODE:-fail}"
AXIAL_MODE="${AGENTS_ADR_AXIAL_MODE:-off}"
FILE="${AGENTS_ADR_FILE:-AGENTS.md}"
ADR_DIR="${AGENTS_ADR_DIR:-docs/architecture/adr}"
DOC="${AGENTS_ADR_DOC:-}"

STATUSES="proposed accepted deprecated superseded"
NON_NORMATIVE="deprecated superseded"

RC=0

# --- family A: bare ADR-NNN references -------------------------------------

if [[ ! -f "$FILE" ]]; then
  echo "WARN: $FILE not found — skip agents-adr bare-ref check" >&2
else
  # Flag lines carrying ADR-N that are not a markdown link, ignoring headings.
  BARE="$(
    grep -nE 'ADR-[0-9]+' "$FILE" 2>/dev/null \
      | grep -vE '\[[^]]*ADR-[0-9]+[^]]*\]\([^)]+\)' \
      | grep -vE '^[0-9]+:\s*#' \
      || true
  )"

  if [[ -z "$BARE" ]]; then
    echo "check-agents-adr-hygiene: no bare ADR-NNN in $FILE — OK"
  else
    COUNT="$(echo "$BARE" | grep -c . || true)"
    TAG="WARN"
    if [[ "$MODE" == "fail" ]]; then TAG="FAIL"; fi

    echo "" >&2
    echo "${TAG}: $FILE has ${COUNT} line(s) with bare ADR-NNN (prefer a domain link or [ADR-N]($ADR_DIR/...)):" >&2
    echo "$BARE" >&2
    echo "" >&2
    if [[ -n "$DOC" ]]; then echo "See $DOC § AGENTS.md ADR hygiene." >&2; fi

    if [[ "$MODE" == "fail" ]]; then RC=1; fi
  fi
fi

# --- family B: ADR frontmatter contract ------------------------------------

frontmatter() {
  awk 'NR==1 && $0=="---" {inf=1; next} inf && $0=="---" {exit} inf {print}' "$1"
}

field() {
  # $1 = frontmatter text, $2 = key. First occurrence, unquoted, trimmed.
  printf '%s\n' "$1" \
    | sed -n "s/^$2:[[:space:]]*//p" \
    | head -1 \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
    | tr -d '\r'
}

contains() {
  # $1 = space-separated set, $2 = needle
  case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

VIOLATIONS=""
add_violation() { VIOLATIONS="${VIOLATIONS}${1}"$'\n'; }

if [[ ! -d "$ADR_DIR" ]]; then
  echo "check-agents-adr-hygiene: $ADR_DIR not found — skip frontmatter contract"
else
  # Recursive on purpose: archived/ ADRs are still bound by the contract, and
  # the axial invariant must hold across the whole corpus.
  ADR_FILES="$(find "$ADR_DIR" -type f \( -name '[0-9]*.md' -o -name '[0-9]*.mdx' \) | sort)"
  ADR_COUNT=0
  AXIAL_FILES=""

  while IFS= read -r f; do
    if [[ -z "$f" ]]; then continue; fi
    ADR_COUNT=$((ADR_COUNT + 1))
    FM="$(frontmatter "$f")"

    if [[ -z "$FM" ]]; then
      add_violation "$f: no YAML frontmatter block"
      continue
    fi

    STATUS="$(field "$FM" status)"
    NORMATIVE="$(field "$FM" normative)"
    DATE="$(field "$FM" date)"
    SUPERSEDED_BY="$(field "$FM" superseded_by)"
    AXIAL="$(field "$FM" axial)"

    if [[ "$AXIAL" == "true" ]]; then AXIAL_FILES="${AXIAL_FILES}${f}"$'\n'; fi

    if [[ -z "$STATUS" ]]; then
      add_violation "$f: missing \`status\` (one of: $STATUSES)"
    elif ! contains "$STATUSES" "$STATUS"; then
      add_violation "$f: status '$STATUS' is not in the vocabulary ($STATUSES) — lowercase, closed set"
    fi

    if [[ -z "$NORMATIVE" ]]; then
      add_violation "$f: missing \`normative\` — binding authority must be explicit"
    elif [[ "$NORMATIVE" != "true" && "$NORMATIVE" != "false" ]]; then
      add_violation "$f: normative '$NORMATIVE' is not true|false"
    elif [[ -n "$STATUS" ]] && contains "$STATUSES" "$STATUS"; then
      EXPECTED=true
      if contains "$NON_NORMATIVE" "$STATUS"; then EXPECTED=false; fi
      if [[ "$NORMATIVE" != "$EXPECTED" ]]; then
        add_violation "$f: status '$STATUS' requires normative: $EXPECTED, found $NORMATIVE"
      fi
    fi

    if [[ -z "$DATE" ]]; then
      add_violation "$f: missing \`date\`"
    elif ! printf '%s' "$DATE" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
      add_violation "$f: date '$DATE' is not YYYY-MM-DD"
    fi

    if [[ "$STATUS" == "superseded" && -z "$SUPERSEDED_BY" ]]; then
      add_violation "$f: status 'superseded' without \`superseded_by\` — a replaced ADR names its replacement"
    fi
    if [[ "$STATUS" != "superseded" && -n "$SUPERSEDED_BY" ]]; then
      add_violation "$f: \`superseded_by\` present but status is '$STATUS'"
    fi

    if grep -qE '^##[[:space:]]+Status[[:space:]]*$' "$f"; then
      add_violation "$f: \`## Status\` body section present — status lives in frontmatter, once"
    fi
  done <<<"$ADR_FILES"

  AXIAL_COUNT="$(printf '%s' "$AXIAL_FILES" | grep -c . || true)"

  # Invariant — two axes of decomposition is a contradiction, never legal.
  if [[ "$AXIAL_COUNT" -gt 1 ]]; then
    add_violation "axial singleton violated: ${AXIAL_COUNT} ADR(s) carry \`axial: true\` (at most 1)"
    add_violation "$(printf '%s' "$AXIAL_FILES" | sed 's/^/  /')"
  # Maturity assertion — opt-in, because zero means "no axis declared yet".
  elif [[ "$ADR_COUNT" -gt 0 && "$AXIAL_COUNT" -eq 0 ]]; then
    AXIAL_MSG="no ADR carries \`axial: true\` — no axis of decomposition declared. Run \`/R-adr --axial\` to declare one"
    case "$AXIAL_MODE" in
      fail) add_violation "$AXIAL_MSG" ;;
      warn) echo "WARN: $AXIAL_MSG." >&2 ;;
      *) echo "check-agents-adr-hygiene: $AXIAL_MSG (AGENTS_ADR_AXIAL_MODE=warn|fail to require it)." ;;
    esac
  fi

  if [[ -z "$VIOLATIONS" ]]; then
    echo "check-agents-adr-hygiene: ${ADR_COUNT} ADR(s) in $ADR_DIR satisfy the frontmatter contract — OK"
  else
    TAG="WARN"
    if [[ "$CONTRACT_MODE" == "fail" ]]; then TAG="FAIL"; fi
    COUNT="$(printf '%s' "$VIOLATIONS" | grep -c . || true)"

    echo "" >&2
    echo "${TAG}: ADR frontmatter contract — ${COUNT} violation(s) in $ADR_DIR:" >&2
    printf '%s' "$VIOLATIONS" >&2
    echo "" >&2
    echo "Contract: status + normative + date on every ADR; superseded_by when superseded; at most one axial: true." >&2
    echo "Run \`/R-adr --migrate\` to backfill an existing corpus." >&2

    if [[ "$CONTRACT_MODE" == "fail" ]]; then RC=1; fi
  fi
fi

exit "$RC"
