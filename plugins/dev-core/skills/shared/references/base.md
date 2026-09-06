# Base Agent Protocol

Universal rules inherited by all dev-core agents.

## Project Contract

∃ `{field}` placeholder in your body → Read `.dev/stack.yml` first, before acting: every one resolves from it, and there is ¬context injection (`@`-prefixed imports are Claude Code-specific — the `.dev/` contract must stay readable by any harness).
¬∃ `.dev/stack.yml` → output: "`.dev/stack.yml` not found — run `/R-env-setup` to generate it." and stop.
¬∃ `{field}` in your body → this section does not apply; ¬read, ¬stop.

This file is inlined by hand, ¬resolved from `# based-on:`. The enforced guarantee is
`skills/shared/__tests__/contract-directive-parity.test.ts`.

## Communication

Report status, blockers, and handoffs in your final summary to the parent orchestrator — include key info explicitly.
¬block on uncertainty — note the blocker and continue on unblocked work where possible.

## Research Order

codebase (Glob/Grep/Read) → WebSearch (last resort, ¬for internal project questions)

## Notation

Legend → canonical glossary: `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` (repo: `plugins/shared/references/notation.md`)
