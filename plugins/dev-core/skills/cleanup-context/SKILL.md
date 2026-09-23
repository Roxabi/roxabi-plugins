---
name: R-cleanup-context
argument-hint: '[--scope <area> | --dry-run]'
description: 'Audit and clean CLAUDE.md, memory, skills, and rules — resolve every finding (fix/promote/relocate/delete), track recurrences, target bloat=0. Triggers: "cleanup context" | "context audit" | "clean memory" | "drain memory" | "prune memory" | "audit memory" | "consolidate rules" | "spa day" | "memory audit".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, ToolSearch
---

# Context Cleanup

**Goal: every ε resolved.** Context files = inbox — stale rules, contradictions, memory entries → permanent home ∨ deleted.

Addresses "rule accumulation decay": rules↑ → performance↑ → too many → contradictions → performance↓ silently.

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  κ := 200 (MEMORY.md line cap)
  λ := .claude/context-audit-log.md (append-only audit log)
  Π := placement targets (auto-detected per project)

```
/R-cleanup-context                    Audit all context areas
/R-cleanup-context --scope claude-md  Only audit CLAUDE.md files
/R-cleanup-context --scope skills     Only audit skill files
/R-cleanup-context --scope memory     Only audit auto-memory (μ + τ + α)
/R-cleanup-context --dry-run          Show findings without proposing fixes
```

## Resolutions

∀ ε → exactly one resolution:

| Resolution | When | Action |
|-----------|------|--------|
| **Fix** | Root cause = bug/wrong config/design flaw | Fix code/config/workflow, delete ε |
| **Promote** | Durable insight needed by multiple agents | Move to permanent target (see Π), delete ε |
| **Relocate** | Domain/agent-specific knowledge in wrong scope | Move to narrower target, delete ε |
| **Delete** | Ephemeral, stale, already covered — ∧ the Promote question was asked and answered "no" | Delete ε |

A finished tracker is ¬automatically Delete: refs all CLOSED/MERGED makes an entry stale **as a status tracker**, so it becomes a candidate whose durable lesson must be offered to **Promote** first. Ref state that cannot be resolved counts as OPEN — keep.

## Dispatch

Phase 1 — Discovery → Read `${CLAUDE_SKILL_DIR}/cookbooks/discovery.md`, execute.
Phase 2 — Analysis → Read `${CLAUDE_SKILL_DIR}/cookbooks/analysis.md`, execute.
Phase 3–5 — Resolution → Read `${CLAUDE_SKILL_DIR}/cookbooks/resolution.md`, execute.

Phase 2's ref-state sweep costs one `gh` round-trip per unique `#NNNN` (≈1s each). It prints the count and the expected wall-clock before the first call; `CLEANUP_CONTEXT_SKIP_GH=1` skips the network and degrades to keeping every entry.

## Safety

1. Never delete entire files — only remove/edit specific lines
2. Never modify files outside the project without explicit approval
3. Always show the exact diff before applying any change
4. Memory files (`~/.claude/projects/*/memory/`) — extra caution, ask before every edit
5. CLAUDE.md changes — show full before/after of modified sections
6. Installed skill files — read-only (report issues, don't modify cache copies)
7. Back up large changes: copy original to `{file}.bak` before multi-line edits
8. Removing a memory file — under **any** resolution, Fix included — → sweep its `[[wikilink]]` backlinks **in the same pass, before the removal** (resolution cookbook); a citation left dangling is indistinguishable from a deliberate forward-reference
9. That sweep *reads* every store (citations cross projects) but *edits* only this one. Out-of-project citations are reported and the pass stops: **Execute all** is consent for this project, ¬the approval rules 2 and 4 require for someone else's store

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No context files found | "No context files discovered. Nothing to audit." |
| All checks pass | "Context is healthy. No issues found." |
| CLAUDE.md imports (@file) | Follow imports, audit imported files too |
| Monorepo with nested CLAUDE.md | Audit each independently, check cross-file consistency |
| User declines all fixes | "No changes applied. Re-run when ready." |
| Agent memory but no agent defs | Report as bloat — orphaned memory with no consumer |

## When to Run

- `/R-cleanup-context` or `/R-dev --cleanup-context` anytime
- After shipping a feature (ephemeral context likely stale)
- After cleaning branches (worktree refs likely stale)
- When memory files > 5 entries or μ > 50 lines
- Periodically after every N completed issues

$ARGUMENTS
