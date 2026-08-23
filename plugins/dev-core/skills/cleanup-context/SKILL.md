---
name: cleanup-context
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
/cleanup-context                    Audit all context areas
/cleanup-context --scope claude-md  Only audit CLAUDE.md files
/cleanup-context --scope skills     Only audit skill files
/cleanup-context --scope memory     Only audit auto-memory (μ + τ + α)
/cleanup-context --dry-run          Show findings without proposing fixes
```

## Resolutions

∀ ε → exactly one resolution:

| Resolution | When | Action |
|-----------|------|--------|
| **Fix** | Root cause = bug/wrong config/design flaw | Fix code/config/workflow, delete ε |
| **Promote** | Durable insight needed by multiple agents | Move to permanent target (see Π), delete ε |
| **Relocate** | Domain/agent-specific knowledge in wrong scope | Move to narrower target, delete ε |
| **Delete** | Ephemeral, stale, already covered, resolved | Delete ε |

## Dispatch

Phase 1 — Discovery → Read `${CLAUDE_SKILL_DIR}/cookbooks/discovery.md`, execute.
Phase 2 — Analysis → Read `${CLAUDE_SKILL_DIR}/cookbooks/analysis.md`, execute.
Phase 3–5 — Resolution → Read `${CLAUDE_SKILL_DIR}/cookbooks/resolution.md`, execute.

## Safety

1. Never delete entire files — only remove/edit specific lines
2. Never modify files outside the project without explicit approval
3. Always show the exact diff before applying any change
4. Memory files (`~/.claude/projects/*/memory/`) — extra caution, ask before every edit
5. CLAUDE.md changes — show full before/after of modified sections
6. Installed skill files — read-only (report issues, don't modify cache copies)
7. Back up large changes: copy original to `{file}.bak` before multi-line edits

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

- `/cleanup-context` or `/dev --cleanup-context` anytime
- After shipping a feature (ephemeral context likely stale)
- After cleaning branches (worktree refs likely stale)
- When memory files > 5 entries or μ > 50 lines
- Periodically after every N completed issues

$ARGUMENTS
