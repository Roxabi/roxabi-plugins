#!/usr/bin/env bash
# Review roster oracle wrapper.
set -euo pipefail
_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$_dir/roster.ts" "$@"
