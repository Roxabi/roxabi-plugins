# Cookbook: Resolution

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  λ := .claude/context-audit-log.md (append-only audit log)
  Π := placement targets (auto-detected per project)

## Phase 3 — Present Resolution Plan

```
Context Audit Report
====================

Contradictions ({N}):
  1. {file_a}:{line} vs {file_b}:{line}
     "{rule_a}" contradicts "{rule_b}"
     Resolution: {Fix|Promote|Relocate|Delete} → {target}

Stale References ({N}):
  1. {file}:{line} — references `{path}` which no longer exists
     Resolution: Delete

Redundancies ({N}):
  1. {file_a}:{line} duplicates {file_b}:{line}
     Resolution: Delete from {file_b}

Bloat ({N}):
  1. {file} is {lines} lines (threshold: {limit})
     Resolution: Promote {section} → {target}

Memory Entries ({N}):
  ε                              | Source | Resolution | Target      | Recur
  CI --allowed-tools finding     | μ      | Promote    | CLAUDE.md   | 1st
  Worktree #389 path             | μ      | Delete     | —           | 1st
  API auth edge case             | α/be   | Relocate   | api/CLAUDE  | 2nd

Score: {healthy | needs attention | bloated}
  Total findings:  {count}
  Contradictions:  {count}
  Stale:           {count}
  Redundant:       {count}
  Memory entries:  {count}
  Recurrences:     {count}
```

`--dry-run` → stop here.

AskUserQuestion: **Execute all** | **1-by-1** (per-ε approve/change) | **Skip**

## Phase 4 — Execute

∀ approved ε, in order:
1. **Fix**: make code/config change, ¬just delete
2. **Promote**: append to target (respect structure)
3. **Relocate**: append to scoped target
4. **Delete**: remove from source

After each → delete ε from source (μ/τ/α/CLAUDE.md). Apply via Edit. Show exact diff before each change.

## Phase 5 — Log + Report

Append to λ (create if ¬∃):

```markdown
## Audit <YYYY-MM-DD>

| ε | Source | Resolution | Target | Recurrence |
|---|--------|-----------|--------|------------|
| ... | ... | ... | ... | Nth |

Summary: <N> fixed, <N> promoted, <N> relocated, <N> deleted
Recurrences: <N> (details)
```

Final report:
```
Context Cleanup Complete
========================
  Before: {N} findings
  After:  {N} remaining
  ─────────────────────
  Fixed:     {N} (code/config changes made)
  Promoted:  {N} (→ permanent docs)
  Relocated: {N} (→ scoped targets)
  Deleted:   {N} (ephemeral/stale/redundant)
  ─────────────────────
  Recurrences: {N} (fix didn't stick)
  Systemic:    {N} (3rd+ occurrence)

Files modified:
  {file_a} — {description}
  {file_b} — {description}
```

Commit after all fixes applied.
