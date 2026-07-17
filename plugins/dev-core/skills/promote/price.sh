#!/usr/bin/env bash
# Usage: price.sh COMPONENT ANCHOR HEAD...
#
# The sole version deriver (spec S2, D10). Prints a bare `X.Y.Z` on stdout and
# nothing else. BASE is chosen by reachability (D1) and component scope (D2):
# the newest `<component>/v*` tag whose commit is reachable from ANCHOR. The
# payload is the set of non-merge commits HEAD... adds over that tag's commit
# (BASE_SHA, never M^1 — D3), classified by the total bump map (D18).
#
# Exit contract (D10):
#   0   → a version on stdout
#   10  → no reachable tag (first release; a legitimate verdict, not an error).
#         Zero component tags and tags-exist-but-none-reachable are distinguished
#         by distinct stderr messages so the caller can warn differently.
#   ≥1  → hard error (bad/missing args, git failure)
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "price.sh: usage: price.sh COMPONENT ANCHOR HEAD..." >&2
  exit 1
fi

COMPONENT=$1
ANCHOR=$2
shift 2
# Remaining "$@" = one or more HEAD refs.

# Resolve refs up front so a garbage ref is a hard error (≥1), never a starved
# reachability set masquerading as "first release" (exit 10). ^{commit} forces
# commit resolution; --quiet + redirect keep stdout clean.
if ! git rev-parse --verify --quiet "${ANCHOR}^{commit}" >/dev/null; then
  echo "price.sh: ANCHOR '${ANCHOR}' is not a valid commit" >&2
  exit 1
fi
for head in "$@"; do
  if ! git rev-parse --verify --quiet "${head}^{commit}" >/dev/null; then
    echo "price.sh: HEAD '${head}' is not a valid commit" >&2
    exit 1
  fi
done

# ── BASE selection (D1/D2): filter-semver → filter-reachable → sort -V → max ──
# Order matters: reachability BEFORE sort. A bare `merge-base --is-ancestor`
# under set -e aborts on a legitimate negative, so it is always guarded by `if`.
semver_count=0     # component tags with a strict X.Y.Z core (distinguish the two exit-10s)
reachable=""       # newline-separated X.Y.Z cores reachable from ANCHOR
while IFS= read -r tag; do
  [ -n "$tag" ] || continue
  ver=${tag#"${COMPONENT}/v"}
  # Strict X.Y.Z only — drop pre-release/garbage (e.g. 0.11.0-rc.1) before sorting.
  [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  semver_count=$((semver_count + 1))
  sha=$(git rev-parse --verify --quiet "${tag}^{commit}") || continue
  if git merge-base --is-ancestor "$sha" "$ANCHOR"; then
    reachable+="${ver}"$'\n'
  fi
done <<< "$(git tag -l "${COMPONENT}/v*")"

if [ "$semver_count" -eq 0 ]; then
  echo "price.sh: no ${COMPONENT}/v* tags — first release" >&2
  exit 10
fi
if [ -z "$reachable" ]; then
  echo "price.sh: ${COMPONENT}/v* tags exist but none reachable from ${ANCHOR}" >&2
  exit 10
fi

# Numeric max — sort -V, never [[ < ]] (which reads 0.10.0 as older than 0.9.0).
BASE=$(printf '%s' "$reachable" | grep -v '^$' | sort -V | tail -n1)
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
  elif printf '%s' "$msg" | grep -qE 'BREAKING[ -]CHANGE'; then
    this=3  # BREAKING CHANGE: footer → major (overrides type)
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
