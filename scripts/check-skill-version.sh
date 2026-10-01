#!/usr/bin/env bash
set -euo pipefail
# R2: skills/ or commands/ changed without a version bump -> block.
# Two independent surfaces, same trigger (plugins/<p>/skills/** and commands/**):
#   Claude: plugins/<p>/.claude-plugin/plugin.json .version
#   OMP:    .omp-plugin/marketplace.json plugins[].version — the cache key
#           (<marketplace>___<plugin>___<version>). Not package.json, not
#           plugins/<p>/.omp-plugin/plugin.json, not the catalogue document version.
# A missing version on one surface is a visible SKIP and does not hide the other.
# Constraints (documented): plugin rename may not fire on the renaming push;
# commands/ dir is forward-compatible (absent today); requires fetched origin/main.
# Preflight skips (explicit, not silent): jq absent -> SKIP; origin/main unreachable -> SKIP.
command -v jq >/dev/null 2>&1 || { echo "SKIP: check-skill-version requires jq (not found)" >&2; exit 0; }
git fetch origin main --quiet 2>/dev/null || true
if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "SKIP: check-skill-version (origin/main unreachable — cannot compare versions)" >&2
  exit 0
fi
changed=$(git diff --name-only origin/main...HEAD -- 'plugins/*/skills/**' 'plugins/*/commands/**')
mapfile -t plugins < <(printf '%s\n' "$changed" | sed -nE 's#^plugins/([^/]+)/.*#\1#p' | sort -u)
fail=0
# Status of the catalogue row OMP keeps for name at rev.
# ABSENT | PARSE | DUPLICATE | MISSING | BAD | VERSION:<token>
# A missing blob or a successful parse with no version field is MISSING/ABSENT.
# Parse failure, a second case-insensitive name match, or a present version that
# is not a cache token is not a SKIP.
omp_row_status() {
  local rev="$1" name="$2" blob parsed ver
  if ! blob=$(git show "${rev}:.omp-plugin/marketplace.json" 2>/dev/null); then
    printf 'ABSENT'
    return 0
  fi
  if ! parsed=$(printf '%s\n' "$blob" | jq -r --arg name "$name" '
    [.plugins[]? | select((.name // "" | ascii_downcase) == ($name | ascii_downcase))]
    | if length > 1 then "DUPLICATE"
      elif length == 0 then "MISSING"
      elif (.[0].version == null) then "MISSING"
      else "VERSION:" + (.[0].version | tostring)
      end
  '); then
    printf 'PARSE'
    return 0
  fi
  case "$parsed" in
    VERSION:*)
      ver="${parsed#VERSION:}"
      if ! printf '%s' "$ver" | grep -Eq '^[A-Za-z0-9._+-]{1,128}$' || printf '%s' "$ver" | grep -q '\.\.'; then
        printf 'BAD'
        return 0
      fi
      ;;
  esac
  printf '%s' "$parsed"
}

omp_fail() {
  echo "$1: $2 — bump .omp-plugin/marketplace.json"
  fail=1
}

for p in "${plugins[@]}"; do
  [ -n "$p" ] || continue
  pj="plugins/$p/.claude-plugin/plugin.json"
  if [ ! -f "$pj" ]; then
    echo "SKIP: $p has no .claude-plugin/plugin.json — no version gate" >&2
  else
    cur=$(jq -r '.version // empty' "$pj" 2>/dev/null || true)
    if [ -z "$cur" ]; then
      echo "SKIP: $p is SHA-based (no .version in $pj) — bump gate inert for this plugin" >&2
    else
      base=$(git show "origin/main:$pj" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
      if [ "$base" = "$cur" ]; then
        echo "$p: skills/commands changed without version bump (still $cur) — bump $pj"
        fail=1
      fi
    fi
  fi

  # OMP cache key is the first kept catalogue row of the commit being pushed,
  # not the worktree file and not the document version.
  cur_status=$(omp_row_status HEAD "$p")
  case "$cur_status" in
    PARSE) omp_fail "$p" "cannot parse .omp-plugin/marketplace.json" ;;
    DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in .omp-plugin/marketplace.json" ;;
    BAD) omp_fail "$p" "catalogue version is not a cache token in .omp-plugin/marketplace.json" ;;
    ABSENT | MISSING)
      echo "SKIP: $p has no version in .omp-plugin/marketplace.json — OMP bump gate inert for this plugin" >&2
      ;;
    VERSION:*)
      cur_omp="${cur_status#VERSION:}"
      base_status=$(omp_row_status origin/main "$p")
      case "$base_status" in
        PARSE) omp_fail "$p" "cannot parse origin/main:.omp-plugin/marketplace.json" ;;
        DUPLICATE) omp_fail "$p" "duplicate plugins[] rows in origin/main:.omp-plugin/marketplace.json" ;;
        BAD) omp_fail "$p" "origin/main catalogue version is not a cache token in .omp-plugin/marketplace.json" ;;
        ABSENT | MISSING) ;;
        VERSION:*)
          base_omp="${base_status#VERSION:}"
          if [ "$base_omp" = "$cur_omp" ]; then
            echo "$p: skills/commands changed without version bump (still $cur_omp) — bump .omp-plugin/marketplace.json"
            fail=1
          fi
          ;;
      esac
      ;;
  esac
done
[ "$fail" -eq 0 ]
