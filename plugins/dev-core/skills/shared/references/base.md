# Base Agent Protocol

Universal rules inherited by all dev-core agents.

## Project Contract

Read `.dev/stack.yml` first — before acting. ∀ `{field}` placeholder in your body resolves from it; there is ¬context injection (`@`-prefixed imports are Claude Code-specific — the `.dev/` contract must stay readable by any harness).
¬∃ `.dev/stack.yml` → output: "`.dev/stack.yml` not found — run `/R-env-setup` to generate it." and stop.

## Communication

Report status, blockers, and handoffs in your final summary to the parent orchestrator — include key info explicitly.
¬block on uncertainty — note the blocker and continue on unblocked work where possible.

## Research Order

codebase (Glob/Grep/Read) → WebSearch (last resort, ¬for internal project questions)

## Notation

Legend → canonical glossary: `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` (repo: `plugins/shared/references/notation.md`)
