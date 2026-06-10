#!/usr/bin/env bash
set -euo pipefail
# R1: block leftover AI-instruction comments in SOURCE (not prose).
hits=$(git grep -nE '(#|//|/\*)[[:space:]]*CLAUDE:' -- \
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.py' '*.sh' \
  ':(exclude)scripts/check-no-claude-comments.sh' || true)
if [ -n "$hits" ]; then echo "Unresolved CLAUDE: comments:"; echo "$hits"; exit 1; fi
