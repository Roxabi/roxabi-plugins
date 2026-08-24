#!/usr/bin/env bash
# Spawn oracle wrapper (#419). Emits spawn_security_auditor + priced_claim_ok.
set -euo pipefail
_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$_dir/claim-roster.ts" "$@"
