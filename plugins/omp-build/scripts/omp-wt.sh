#!/usr/bin/env bash
exec bun "$(dirname "$(readlink -f "$0")")/omp-wt.mjs" "$@"
