#!/usr/bin/env bash
set -euo pipefail
# R2: versioned plugin's skills/ or commands/ changed without a version bump -> block.
# Constraints (documented): plugin rename may not fire on the renaming push;
# commands/ dir is forward-compatible (absent today); requires fetched origin/staging.
# Preflight skips (explicit, not silent): jq absent -> SKIP; origin/staging unreachable -> SKIP.
command -v jq >/dev/null 2>&1 || { echo "SKIP: check-skill-version requires jq (not found)" >&2; exit 0; }
git fetch origin staging --quiet 2>/dev/null || true
if ! git rev-parse --verify --quiet origin/staging >/dev/null; then
  echo "SKIP: check-skill-version (origin/staging unreachable — cannot compare versions)" >&2
  exit 0
fi
changed=$(git diff --name-only origin/staging...HEAD -- 'plugins/*/skills/**' 'plugins/*/commands/**')
mapfile -t plugins < <(printf '%s\n' "$changed" | sed -nE 's#^plugins/([^/]+)/.*#\1#p' | sort -u)
fail=0
for p in "${plugins[@]}"; do
  [ -n "$p" ] || continue
  pj="plugins/$p/.claude-plugin/plugin.json"
  [ -f "$pj" ] || continue
  cur=$(jq -r '.version // empty' "$pj" 2>/dev/null || true)
  [ -n "$cur" ] || continue   # SHA-based plugin -> skip
  base=$(git show "origin/staging:$pj" 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
  if [ "$base" = "$cur" ]; then
    echo "$p: skills/commands changed without version bump (still $cur) — bump $pj"; fail=1
  fi
done
[ "$fail" -eq 0 ]
