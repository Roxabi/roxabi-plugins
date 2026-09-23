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
# EXIT: 0 when no family in fail mode reported a violation; 1 otherwise. Those
# are the only two codes. This script ships **by value** into consumer repos, so
# a caller cannot read it to find out what a third code meant; every internal
# failure is therefore reported as a violation of the family it happened in, and
# the EXIT trap below converts an unanticipated abort into a loud 1 rather than
# letting `set -e` leak an awk/find/SIGPIPE status as if it were a verdict.
set -euo pipefail

# Bumped whenever the enforced contract changes (vocabulary, fields, rules).
# Declared once in adr-template.md and bound to this value by a guard test.
# Seeded copies are frozen at the version they were copied at: `/R-dev-init`
# compares them and says so, because a stale copy rejecting a legal ADR is
# otherwise indistinguishable from an illegal ADR.
CONTRACT_VERSION="2"

trap 'RC_EXIT=$?; if [[ "$RC_EXIT" -ne 0 && "$RC_EXIT" -ne 1 ]]; then
  echo "FAIL: check-agents-adr-hygiene aborted (rc=$RC_EXIT) — the gate could not complete, treat as red" >&2
  exit 1
fi' EXIT

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

# YAML 1.1 boolean spellings. `axial: True` and `axial: yes` are `true` to any
# YAML parser; a check that tests for the literal `true` reports an ADR that
# declares the axis as not declaring it, and the zero-axial branch below is what
# tells `/R-adr --axial` to write a second one. Recognised on read, rejected on
# disk, so the corpus converges on one spelling.
YAML_TRUE="true True TRUE y Y yes Yes YES on On ON"
YAML_FALSE="false False FALSE n N no No NO off Off OFF"

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

# Emit the frontmatter block, or refuse to.
#
#   10 = no opening `---` on line 1
#   11 = opened and never closed
#    2 = awk could not read the file (unreadable, vanished mid-scan)
#
# The unclosed case must not fall back to "print what I saw". The previous awk
# never fired its terminator, so it emitted the whole document and the field
# reader below harvested `status`/`normative`/`date` out of body prose: a file
# with a dangling fence was certified as satisfying the frontmatter contract
# while every YAML reader saw no frontmatter at all.
#
# Lines are held in an array, not appended to a scalar: repeated `buf = buf $0`
# is quadratic in mawk, so a pathological block turned a gate into a hang.
frontmatter() {
  awk '
    NR==1 && $0=="---" { inf=1; next }
    inf && $0=="---"   { closed=1; exit }
    inf                { lines[++n] = $0 }
    END {
      if (!inf)    exit 10
      if (!closed) exit 11
      for (i = 1; i <= n; i++) print lines[i]
    }
  ' "$1"
}

# $1 = frontmatter text, $2 = key. First occurrence, unquoted, trimmed.
#
# One reader process, and it drains its input. The previous `sed | head -1`
# took SIGPIPE when head left while sed was still writing, and `pipefail`
# promoted that to a 141 exit from the whole gate — a status the script's own
# documented exit contract has no meaning for. An `exit` on first match here
# would reintroduce exactly that race against `printf`, so the first hit is
# latched instead and the rest of the block is read and discarded.
field() {
  printf '%s\n' "$1" | awk -v key="$2" '
    !found && index($0, key ":") == 1 {
      v = substr($0, length(key) + 2)
      gsub(/\r/, "", v)
      sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v)
      sub(/^"/, "", v);  sub(/"$/, "", v)
      sub(/^'\''/, "", v); sub(/'\''$/, "", v)
      value = v
      found = 1
    }
    END { if (found) print value }
  '
}

contains() {
  # $1 = space-separated set, $2 = needle
  case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}

# An ADR filename: {NNN}-{slug}.md|.mdx, NNN padded to 3 or 4 digits, and not a
# YYYY-MM-DD- dated note. Held equal to the TypeScript reader's predicate by a
# guard test: the two disagreeing on *what an ADR is* left `12.md` bound by this
# gate and invisible to `adr.ts`, and let `2026-08-24-notes.md` set the next
# number to 2027.
is_adr_name() {
  case "$1" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*) return 1 ;;
  esac
  case "$1" in
    [0-9][0-9][0-9]-*.md | [0-9][0-9][0-9]-*.mdx | [0-9][0-9][0-9][0-9]-*.md | [0-9][0-9][0-9][0-9]-*.mdx) return 0 ;;
    *) return 1 ;;
  esac
}

VIOLATIONS=""
add_violation() { VIOLATIONS="${VIOLATIONS}${1}"$'\n'; }

if [[ ! -d "$ADR_DIR" ]]; then
  echo "check-agents-adr-hygiene: $ADR_DIR not found — skip frontmatter contract"
else
  # Recursive on purpose: archived/ ADRs are still bound by the contract, and
  # the axial invariant must hold across the whole corpus.
  #
  # `find` runs with its stderr captured rather than inherited. An unreadable
  # subdirectory used to abort the whole gate through `set -e` with an empty
  # violation list, which reads exactly like "nothing to report".
  FIND_ERR="$(mktemp)"
  ALL_FILES="$(find "$ADR_DIR" -type f \( -name '*.md' -o -name '*.mdx' \) 2>"$FIND_ERR" | sort || true)"
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then add_violation "$ADR_DIR: corpus scan incomplete — $line"; fi
  done <"$FIND_ERR"
  rm -f "$FIND_ERR"

  ADR_COUNT=0
  AXIAL_FILES=""
  NNN_SEEN=""

  while IFS= read -r f; do
    if [[ -z "$f" ]]; then continue; fi
    BASE="${f##*/}"

    if ! is_adr_name "$BASE"; then
      # Only files that *claim* ADR shape are reported. A README or a note with
      # a word-initial name is not this contract's business; `12.md` and
      # `2026-08-24-notes.md` are, because one escapes the contract and the
      # other poisons number allocation, silently, in opposite directions.
      case "$BASE" in
        [0-9]*) add_violation "$f: name does not parse as an ADR — expected \`{NNN}-{slug}.md\`, NNN padded to 3 or 4 digits" ;;
      esac
      continue
    fi

    ADR_COUNT=$((ADR_COUNT + 1))

    NNN="${BASE%%-*}"
    NNN_KEY="$((10#$NNN))"
    if contains "$NNN_SEEN" "$NNN_KEY"; then
      add_violation "$f: ADR-${NNN_KEY} is already claimed by another document — one number, one decision"
    else
      NNN_SEEN="$NNN_SEEN $NNN_KEY"
    fi

    FM=""
    FM_RC=0
    FM="$(frontmatter "$f")" || FM_RC=$?
    case "$FM_RC" in
      0) ;;
      10)
        add_violation "$f: no YAML frontmatter block"
        continue
        ;;
      11)
        add_violation "$f: frontmatter block is opened and never closed — no terminating \`---\`, so no reader sees any frontmatter"
        continue
        ;;
      *)
        add_violation "$f: unreadable — frontmatter scan failed (rc=$FM_RC)"
        continue
        ;;
    esac

    if [[ -z "$FM" ]]; then
      add_violation "$f: empty YAML frontmatter block"
      continue
    fi

    STATUS="$(field "$FM" status)"
    NORMATIVE="$(field "$FM" normative)"
    DATE="$(field "$FM" date)"
    SUPERSEDED_BY="$(field "$FM" superseded_by)"
    IN_PART="$(field "$FM" superseded_in_part_by)"
    AXIAL="$(field "$FM" axial)"

    # Counted by meaning, rejected by spelling: an aliased `axial: True` must
    # not read as "no axis declared" — that is the signal that starts the
    # interview which writes a second axial ADR — and must not stay aliased.
    if contains "$YAML_TRUE" "$AXIAL"; then AXIAL_FILES="${AXIAL_FILES}${f}"$'\n'; fi
    if [[ -n "$AXIAL" ]]; then
      if contains "$YAML_FALSE" "$AXIAL"; then
        add_violation "$f: \`axial: $AXIAL\` — the contract spells a non-axial ADR by omitting the key, not by denying it"
      elif ! contains "$YAML_TRUE" "$AXIAL"; then
        add_violation "$f: \`axial: $AXIAL\` is not a boolean — the only legal value is \`true\`"
      elif [[ "$AXIAL" != "true" ]]; then
        add_violation "$f: \`axial: $AXIAL\` is a YAML boolean alias — the contract spells it \`true\`, and a reader testing the literal sees no axis"
      fi
    fi

    if [[ -z "$STATUS" ]]; then
      add_violation "$f: missing \`status\` (one of: $STATUSES)"
    elif ! contains "$STATUSES" "$STATUS"; then
      add_violation "$f: status '$STATUS' is not in the vocabulary ($STATUSES) — lowercase, closed set [gate implements contract v$CONTRACT_VERSION]"
    fi

    if [[ -z "$NORMATIVE" ]]; then
      add_violation "$f: missing \`normative\` — binding authority must be explicit"
    elif [[ "$NORMATIVE" != "true" && "$NORMATIVE" != "false" ]]; then
      if contains "$YAML_TRUE $YAML_FALSE" "$NORMATIVE"; then
        add_violation "$f: \`normative: $NORMATIVE\` is a YAML boolean alias — the contract spells it \`true\` or \`false\`"
      else
        add_violation "$f: normative '$NORMATIVE' is not true|false"
      fi
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
      add_violation "$f: status 'superseded' without \`superseded_by\` — a replaced ADR names its replacement. Supply the replacement; do not downgrade the status to make this line go away"
    fi
    if [[ "$STATUS" != "superseded" && -n "$SUPERSEDED_BY" ]]; then
      add_violation "$f: \`superseded_by\` present but status is '$STATUS'"
    fi

    # `superseded_in_part_by` qualifies a record still in force: "binding,
    # except for these parts". On a wholly-replaced record it is a
    # contradiction; on an in-force one it is the only place the exception is
    # recorded, since body prose is not authoritative under this contract.
    if [[ -n "$IN_PART" ]]; then
      if [[ -n "$STATUS" ]] && contains "$NON_NORMATIVE" "$STATUS"; then
        add_violation "$f: \`superseded_in_part_by\` on a '$STATUS' ADR — a record that is wholly replaced has no parts left in force"
      fi
      REFS="$(printf '%s' "$IN_PART" | tr -d '[]' | tr ',' ' ')"
      if [[ -z "${REFS// /}" ]]; then
        add_violation "$f: \`superseded_in_part_by\` is empty — omit the key instead"
      fi
      for ref in $REFS; do
        ref="${ref%\"}"; ref="${ref#\"}"; ref="${ref%\'}"; ref="${ref#\'}"
        if ! printf '%s' "$ref" | grep -qE '^(ADR-[0-9]{3,4}|#[0-9]+)$'; then
          add_violation "$f: \`superseded_in_part_by\` entry '$ref' is not an \`ADR-NNN\` or \`#NNN\` reference"
        elif [[ "$ref" == "ADR-$NNN" ]]; then
          add_violation "$f: \`superseded_in_part_by\` names itself ($ref)"
        fi
      done
    fi

    # Case-insensitive on purpose: the TypeScript reader strips `## status` as
    # readily as `## Status`, so a case-sensitive gate blessed a section the
    # other half of the contract deletes.
    if grep -qiE '^##[[:space:]]+status[[:space:]]*$' "$f"; then
      add_violation "$f: \`## Status\` body section present — status lives in frontmatter, once"
    fi
  done <<<"$ALL_FILES"

  AXIAL_COUNT="$(printf '%s' "$AXIAL_FILES" | grep -c . || true)"

  # Invariant — two axes of decomposition is a contradiction, never legal.
  if [[ "$AXIAL_COUNT" -gt 1 ]]; then
    add_violation "axial singleton violated: ${AXIAL_COUNT} ADR(s) declare an axis (at most 1)"
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
    echo "check-agents-adr-hygiene: ${ADR_COUNT} ADR(s) in $ADR_DIR satisfy the frontmatter contract v$CONTRACT_VERSION — OK"
  else
    TAG="WARN"
    if [[ "$CONTRACT_MODE" == "fail" ]]; then TAG="FAIL"; fi
    COUNT="$(printf '%s' "$VIOLATIONS" | grep -c . || true)"

    echo "" >&2
    echo "${TAG}: ADR frontmatter contract — ${COUNT} violation(s) in $ADR_DIR:" >&2
    printf '%s' "$VIOLATIONS" >&2
    echo "" >&2
    echo "Contract v$CONTRACT_VERSION: status + normative + date on every ADR; superseded_by when superseded;" >&2
    echo "superseded_in_part_by on an in-force ADR that lost a part; at most one axial: true." >&2
    echo "Run \`/R-adr --migrate\` to backfill an existing corpus." >&2
    echo "Fix the ADR, never the record the violation describes: an ADR downgraded to silence this gate is a falsified decision record." >&2
    echo "If an ADR is legal upstream but rejected here, this copy is frozen at v$CONTRACT_VERSION — re-seed it with \`/R-dev-init\`." >&2

    if [[ "$CONTRACT_MODE" == "fail" ]]; then RC=1; fi
  fi
fi

exit "$RC"
