#!/usr/bin/env bash
# Shared trufflehog scan — called from lefthook pre-commit and pre-push.
# Uses mktemp + trap for safe cleanup of the exclusion file.
set -euo pipefail

excl=$(mktemp)
trap 'rm -f "$excl"' EXIT

echo 'node_modules' > "$excl"

if [ -f .git ] && grep -q '^gitdir:' .git; then
  trufflehog filesystem . --only-verified --fail -x "$excl"
else
  trufflehog git file://. --only-verified --fail
fi
