#!/usr/bin/env bash
# Usage:
#   price.sh COMPONENT ANCHOR HEAD...      → print the derived version X.Y.Z
#   price.sh --base-only COMPONENT ANCHOR  → print only the BASE floor X.Y.Z (D1/D2)
#
# The sole version deriver (spec S2, D10). Prints a bare `X.Y.Z` on stdout and
# nothing else. BASE is chosen by reachability (D1) and component scope (D2):
# the newest `<component>/v*` tag whose commit is reachable from ANCHOR. The
# payload is the set of non-merge commits HEAD... adds over that tag's commit
# (BASE_SHA, never M^1 — D3), classified by the total bump map (D18).
#
# `--base-only` exposes the SAME BASE selection so the release-consistency gate's
# at-rest floor check reuses it instead of re-implementing the predicate — one
# deriver, no drift (the gate's push path was a second copy of this loop before #369).
#
# Exit contract (D10):
#   0   → a version (or BASE, with --base-only) on stdout
#   10  → no reachable tag (first release; a legitimate verdict, not an error).
#         Zero component tags and tags-exist-but-none-reachable are distinguished
#         by distinct stderr messages so the caller can warn differently.
#   ≥1  → hard error (bad/missing args, git failure)
set -euo pipefail

# ── BASE selection (D1/D2): filter-semver → filter-reachable → sort -V → max ──
# Prints the newest <component>/v* tag core (X.Y.Z) reachable from ANCHOR. Returns 11 if the
# component has zero strict-semver tags, 10 if tags exist but none is reachable — both are the
# "first release" verdict, kept distinct only for the stderr message. Order matters: reachability
# BEFORE sort. A bare `merge-base --is-ancestor` under set -e aborts on a legitimate negative, so
# it is always guarded by `if`.
select_base() {
  local component=$1 anchor=$2
  local semver_count=0 reachable="" tag ver sha
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    ver=${tag#"${component}/v"}
    # Strict X.Y.Z only — drop pre-release/garbage (e.g. 0.11.0-rc.1) before sorting.
    [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    semver_count=$((semver_count + 1))
    sha=$(git rev-parse --verify --quiet "${tag}^{commit}") || continue
    if git merge-base --is-ancestor "$sha" "$anchor"; then
      reachable+="${ver}"$'\n'
    fi
  done <<< "$(git tag -l "${component}/v*")"
  [ "$semver_count" -ne 0 ] || return 11
  [ -n "$reachable" ] || return 10
  # Numeric max — sort -V, never [[ < ]] (which reads 0.10.0 as older than 0.9.0).
  printf '%s' "$reachable" | grep -v '^$' | sort -V | tail -n1
}

# Translate select_base's rc into the exit-10 contract with the distinguishing stderr message.
emit_first_release_and_exit() {
  local rc=$1 component=$2 anchor=$3
  case "$rc" in
    11) echo "price.sh: no ${component}/v* tags — first release" >&2 ;;
    10) echo "price.sh: ${component}/v* tags exist but none reachable from ${anchor}" >&2 ;;
    *)  echo "price.sh: select_base failed (rc ${rc})" >&2; exit "${rc:-1}" ;;
  esac
  exit 10
}

# Resolve a ref to a commit up front so a garbage ref is a hard error (≥1), never a starved
# reachability set masquerading as "first release" (exit 10). ^{commit} forces commit
# resolution; --quiet + redirect keep stdout clean.
require_commit() {
  git rev-parse --verify --quiet "${1}^{commit}" >/dev/null || {
    echo "price.sh: '${1}' is not a valid commit" >&2
    exit 1
  }
}

# ── --base-only mode: print the BASE floor and stop (gate reuse, D1/D2) ──
if [ "${1:-}" = "--base-only" ]; then
  shift
  if [ "$#" -ne 2 ]; then
    echo "price.sh: usage: price.sh --base-only COMPONENT ANCHOR" >&2
    exit 1
  fi
  COMPONENT=$1
  ANCHOR=$2
  require_commit "$ANCHOR"
  set +e
  BASE=$(select_base "$COMPONENT" "$ANCHOR")
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || emit_first_release_and_exit "$rc" "$COMPONENT" "$ANCHOR"
  echo "$BASE"
  exit 0
fi

# ── Normal mode: COMPONENT ANCHOR HEAD... → derived version ──
if [ "$#" -lt 3 ]; then
  echo "price.sh: usage: price.sh COMPONENT ANCHOR HEAD..." >&2
  exit 1
fi

COMPONENT=$1
ANCHOR=$2
shift 2
# Remaining "$@" = one or more HEAD refs.

require_commit "$ANCHOR"
for head in "$@"; do
  require_commit "$head"
done

set +e
BASE=$(select_base "$COMPONENT" "$ANCHOR")
rc=$?
set -e
[ "$rc" -eq 0 ] || emit_first_release_and_exit "$rc" "$COMPONENT" "$ANCHOR"

BASE_SHA=$(git rev-parse --verify "${COMPONENT}/v${BASE}^{commit}")

# ── Payload (D3): the set difference floored at BASE_SHA, classified per D18 ──
payload=$(git rev-list --no-merges "^${BASE_SHA}" "$@")

# level: 0 none · 1 patch · 2 minor · 3 major — highest wins.
level=0
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  msg=$(git log -1 --format='%B' "$sha")
  subject=${msg%%$'\n'*}
  this=1  # unknown/other conventional type → patch (D18)
  if [[ "$subject" =~ ^[a-zA-Z]+(\([^\)]*\))?!: ]]; then
    this=3  # `!` bump marker → major
  elif printf '%s' "$msg" | grep -qE '^BREAKING[ -]CHANGE:'; then
    # BREAKING CHANGE footer (line-anchored + colon) → major, overrides type. Unanchored before
    # #369 — a prose mention ("this is not a BREAKING CHANGE") forced a false major bump.
    this=3
  elif [[ "$subject" =~ ^feat(\([^\)]*\))?: ]]; then
    this=2  # feat → minor
  fi
  if [ "$this" -gt "$level" ]; then level=$this; fi
done <<< "$payload"

# Empty payload (level still 0) → derived == BASE, no bump.
IFS='.' read -r MA MI PA <<< "$BASE"
case "$level" in
  3) MA=$((MA + 1)); MI=0; PA=0 ;;
  2) MI=$((MI + 1)); PA=0 ;;
  1) PA=$((PA + 1)) ;;
  *) : ;;
esac

echo "${MA}.${MI}.${PA}"
