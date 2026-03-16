# Cookbook: Analysis

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  κ := 200 (MEMORY.md line cap)
  Π := placement targets (auto-detected per project)

## Phase 2 — Analyze for Findings

Read each file. Build ε set:

### 2a. Contradictions
Two semantically conflicting rules (e.g., "use semicolons" vs "no semicolons", snake_case vs camelCase, "run tests first" vs "skip tests").
Detection: read all rules → build directive list → pairwise conflict check.

### 2b. Staleness
Rules referencing: ¬∃ files/paths (`Glob` to verify) | ¬installed deps (`grep package.json`) | deprecated tools/patterns | completed TODOs listed pending | issue #N / PR refs / branch names / worktree paths (ephemeral).

```bash
test -f "<path from ε>" && echo "EXISTS" || echo "STALE"
grep -rl "<key phrase>" CLAUDE.md $(find . -maxdepth 3 -name "CLAUDE.md") .claude/agents/*.md 2>/dev/null
```

### 2c. Redundancy
Same rule in multiple files (exact/near-dup) | overlapping trigger phrases | memory entries duplicating CLAUDE.md | content already in Π targets.

### 2d. Bloat
CLAUDE.md > 500 lines | memory > κ lines | > 10 skills | overly specific rules.

### 2e. Memory Entries (μ + τ + α)

∀ entry, classify:

| Signal | Resolution |
|--------|-----------|
| Bug/workaround | **Fix** (root cause) |
| Cross-cutting insight ¬in permanent docs | **Promote** (→ Π) |
| Agent/domain-specific in global memory | **Relocate** (→ scoped target) |
| References #N, PR, branch, worktree | **Delete** (ephemeral) |
| References ¬∃ file/workflow | **Delete** (stale) |
| Already in Π targets | **Delete** (redundant) |
