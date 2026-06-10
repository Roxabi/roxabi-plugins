#!/usr/bin/env bash
set -euo pipefail
# R2: versioned plugin's skills/ or commands/ changed without a version bump -> block.
# Constraints (documented): plugin rename may not fire on the renaming push;
# commands/ dir is forward-compatible (absent today); requires fetched origin/staging.
git fetch origin staging --quiet 2>/dev/null || true
changed=$(git diff --name-only origin/staging...HEAD -- 'plugins/*/skills/**' 'plugins/*/commands/**' || true)
plugins=$(echo "$changed" | sed -nE 's#^plugins/([^/]+)/.*#\1#p' | sort -u)
fail=0
for p in $plugins; do
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
