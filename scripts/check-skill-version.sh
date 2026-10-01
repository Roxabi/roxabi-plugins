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

  # OMP cache key is the catalogue row, not the document version at the top of the file.
  omp=".omp-plugin/marketplace.json"
  cur_omp=""
  if [ -f "$omp" ]; then
    cur_omp=$(jq -r --arg name "$p" '[.plugins[]? | select(.name == $name) | .version // empty][0] // empty' "$omp" 2>/dev/null || true)
    cur_omp=$(printf '%s' "$cur_omp" | tr -d '[:space:]')
  fi
  if [ -z "$cur_omp" ]; then
    echo "SKIP: $p has no version in .omp-plugin/marketplace.json — OMP bump gate inert for this plugin" >&2
  else
    base_omp=$(git show "origin/main:$omp" 2>/dev/null | jq -r --arg name "$p" '[.plugins[]? | select(.name == $name) | .version // empty][0] // empty' 2>/dev/null || true)
    base_omp=$(printf '%s' "$base_omp" | tr -d '[:space:]')
    if [ "$base_omp" = "$cur_omp" ]; then
      echo "$p: skills/commands changed without version bump (still $cur_omp) — bump .omp-plugin/marketplace.json"
      fail=1
    fi
  fi
done
[ "$fail" -eq 0 ]
