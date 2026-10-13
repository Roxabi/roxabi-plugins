#!/usr/bin/env bash
# Review roster oracle wrapper. path_hit / priced-fence parsing: #419.
set -euo pipefail
_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$_dir/roster.ts" "$@"
