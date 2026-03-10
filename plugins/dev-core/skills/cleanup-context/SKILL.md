---
name: cleanup-context
argument-hint: '[--scope <area> | --dry-run]'
description: 'Audit and clean CLAUDE.md, memory, skills, and rules — resolve every finding (fix/promote/relocate/delete), track recurrences, target bloat=0. Triggers: "cleanup context" | "context audit" | "clean memory" | "drain memory" | "prune memory" | "audit memory" | "consolidate rules" | "spa day" | "memory audit".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob, Grep, ToolSearch, AskUserQuestion
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

### Placement Hierarchy

Promote/relocate → pick **narrowest** target covering all consumers.

**Auto-discover Π:**

```bash
echo "=== Discovering placement targets (Π) ==="

# Root CLAUDE.md
test -f CLAUDE.md && echo "ROOT: CLAUDE.md"

# Agent coordination
test -f AGENTS.md && echo "AGENTS: AGENTS.md"

# Subfolder CLAUDE.md (monorepo domains)
find . -maxdepth 3 -name "CLAUDE.md" ! -path "./CLAUDE.md" ! -path "./.claude/*" 2>/dev/null | while read f; do
  echo "DOMAIN: $f"
done

# Agent definitions
ls .claude/agents/*.md 2>/dev/null | while read f; do
  echo "AGENT: $f"
done

# Skill definitions
ls .claude/skills/*/SKILL.md 2>/dev/null | while read f; do
  echo "SKILL: $f"
done

# Documentation directories
for d in docs doc documentation; do
  test -d "$d" && echo "DOCS: $d/"
done
```

**Placement rules** (narrowest scope wins):

```
All agents need it?              → CLAUDE.md (root)
Agent coordination/delegation?   → AGENTS.md (if exists)
All agents in one domain?        → <domain>/CLAUDE.md (if exists)
Single agent type?               → .claude/agents/<agent>.md (if exists)
Single skill?                    → .claude/skills/<skill>/SKILL.md (if exists)
Human-facing documentation?      → docs/ directory (if exists)
No target found?                 → CLAUDE.md (root) as fallback
```

## Audit Log + Recurrence Detection

λ = `.claude/context-audit-log.md` — append-only, persists across audits, stored in `.claude/`.

Before classifying, scan λ for prior similar resolutions:

```bash
grep -i "<key phrase>" .claude/context-audit-log.md 2>/dev/null
```

| Count | Signal | Action |
|-------|--------|--------|
| 1st | Normal | Resolve normally |
| 2nd | **Fix didn't stick** | Investigate: wrong target? agents ¬reading? docs unclear? |
| 3rd+ | **Systemic gap** | Create issue to fix root cause |

Recurrence ≥ 2 → AskUserQuestion with root-cause options:
- **Wrong target** — agents ¬read location → move
- **Unclear docs** — ambiguous/buried → rewrite at target
- **Agent prompt gap** — agent def ¬references right docs → fix agent .md
- **Process gap** — no target fits → create new section/file
- **Create issue** — too complex now, track it

## Phase 1 — Discover + Inventory

```bash
# CLAUDE.md files (project root + nested)
find . -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null

# Project memory (μ + τ) — current project only
project_dir=$(echo "$PWD" | sed 's|/|-|g; s|^-||')
memory_dir="$HOME/.claude/projects/$project_dir/memory"
ls -la "$memory_dir/" 2>/dev/null || echo "No project memory"

# Agent memory (α) — current project only
ls -la .claude/agent-memory/*/MEMORY.md 2>/dev/null || echo "No agent memory"

# Installed plugins — names only (¬expose full settings/permissions)
test -f .claude/settings.json && echo "Settings: exists" || echo "Settings: missing"

# Prior audit log
test -f .claude/context-audit-log.md && wc -l .claude/context-audit-log.md || echo "No prior audits"
```

`--scope` → filter to matching area only.

Report:
```
Context Inventory
  CLAUDE.md files:  {N} found ({total_lines} lines)
  Memory (μ):       {lines} / κ cap ({pct}%)
  Topic files (τ):  {N} files ({total_lines} lines)
  Agent memory (α): {N} agents ({total_entries} entries)
  Installed skills: {N} found
  Prior audits:     {N} (last: {date})
```

All sources empty → "Context is clean — nothing to audit." **Stop.**

**Auto-discover Π** (run placement discovery script).

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

¬commit automatically. User decides when.

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
