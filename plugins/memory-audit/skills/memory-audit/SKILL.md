---
name: memory-audit
description: 'Audit and drain Claude Code auto-memory — every entry gets resolved (fix/promote/relocate/delete), target is memory=0. Triggers: "memory-audit" | "audit memory" | "clean memory" | "prune memory" | "drain memory".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob
---

# Memory Audit

**Goal: μ → 0.** Memory is an inbox, not a knowledge base. Every ε must be resolved to a permanent home or deleted.

Let:
  ε := entry (H2 section `##` or top-level bullet cluster)
  μ := MEMORY.md                    — first κ lines injected every session
  τ := memory/*.md                  — topic files, loaded on demand
  κ := 200                          — line cap
  δ := ~/.claude/projects/<project>/memory/    — project memory (orchestrator)
  α := .claude/agent-memory/*/MEMORY.md        — agent memory (per-agent)
  λ := .claude/memory-audit-log.md             — audit log (append-only)
  Π := discovered placement targets            — auto-detected per project

## Resolutions

Every ε resolves to exactly one:

| Resolution | When | Action |
|-----------|------|--------|
| **Fix** | Root cause is a bug or design flaw | Fix the code/config/workflow, then delete ε |
| **Promote** | Durable insight needed by multiple agents | Move content to permanent target (see placement), delete ε |
| **Relocate** | Domain/agent-specific knowledge | Move to scoped target (see placement), delete ε |
| **Delete** | Ephemeral, stale, already covered, or resolved by fix/promote/relocate | Delete ε |

### Placement Hierarchy

When promoting or relocating, pick the **narrowest** target that covers all consumers.

**Auto-discover Π** by scanning the project:

```bash
echo "=== Discovering placement targets (Π) ==="

# Root CLAUDE.md (always exists in Claude Code projects)
test -f CLAUDE.md && echo "ROOT: CLAUDE.md"

# Agent coordination file
test -f AGENTS.md && echo "AGENTS: AGENTS.md"

# Subfolder CLAUDE.md files (monorepo domains)
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
∀ agents need it?              → CLAUDE.md (root)
Agent coordination/delegation? → AGENTS.md (if ∃)
∀ agents in one domain?        → <domain>/CLAUDE.md (if ∃)
Single agent type?             → .claude/agents/<agent>.md (if ∃)
Single skill?                  → .claude/skills/<skill>/SKILL.md (if ∃)
Human-facing documentation?    → docs/ directory (if ∃)
¬target found?                 → CLAUDE.md (root) as fallback
```

## Audit Log

Log: λ (`.claude/memory-audit-log.md`) — append-only, persists across audits. Stored in `.claude/` so it travels with the project.

```markdown
## Audit <YYYY-MM-DD>

| ε | Source | Resolution | Target | Recurrence |
|---|--------|-----------|--------|------------|
| CI --allowed-tools | δ/μ | Promote | CLAUDE.md | 1st |
| CSS injection pattern | α/frontend-dev | Relocate | apps/web/CLAUDE.md | 2nd ⚠️ |
| Worktree #389 | δ/μ | Delete | — | 1st |

Recurrences: 1 (CSS injection — promoted in prior audit but reappeared)
```

### Recurrence Detection

Before classifying (Phase 2), scan λ for prior resolutions of similar entries:

```bash
# Check if key phrase from ε was resolved before
grep -i "<key phrase>" .claude/memory-audit-log.md 2>/dev/null
```

Recurrence = ε resolves to same topic as a prior audit entry:

| Count | Signal | Action |
|-------|--------|--------|
| 1st | Normal | Resolve normally |
| 2nd | **Fix didn't stick** ⚠️ | Investigate: wrong target? agents not reading it? docs unclear? |
| 3rd+ | **Systemic gap** 🔴 | Permanent home is broken. Create issue to fix root cause |

∀ ε with recurrence ≥ 2: AskUserQuestion with root cause options:
- **Wrong target** — placed somewhere agents don't read → move to better location
- **Unclear docs** — exists but ambiguous/buried → rewrite at target
- **Agent prompt gap** — agent def doesn't reference the right docs → fix agent .md
- **Process gap** — no target fits → create new section/file
- **Create issue** — too complex to fix now, track it

## Instructions

### Phase 1 — Inventory

1. Detect δ + α:
```bash
project_dir=$(echo "$PWD" | sed 's|/|-|g; s|^-||')
memory_dir="$HOME/.claude/projects/$project_dir/memory"
echo "=== Project memory (δ) ==="
echo "Memory dir: $memory_dir"
ls -la "$memory_dir/" 2>/dev/null || echo "No project memory directory found"

echo "=== Agent memory (α) ==="
ls -la .claude/agent-memory/*/MEMORY.md 2>/dev/null || echo "No agent memory files found"

echo "=== Audit log (λ) ==="
test -f .claude/memory-audit-log.md && wc -l .claude/memory-audit-log.md || echo "No prior audits"
```

2. Read μ + all τ + all α. ∀ file: count lines, parse into ε set.

3. Report:
```
Memory Audit Inventory
  Project memory (δ):
    MEMORY.md: <N> lines / κ cap (<N>%)
    Topic files: |τ| (<total lines>)
  Agent memory (α):
    <agent>: <N> lines / <N> entries
    ...
  Total entries: |ε|
  Prior audits: <N> (last: <date>)
```

δ ∄ ∧ α = ∅ → report "Memory is clean — all sources = 0", halt.

### Phase 2 — Discover + Classify

1. **Auto-discover Π** (run the discovery script above)
2. **Scan λ** for prior resolutions (recurrence check)
3. ∀ ε determine resolution:

| Signal | Resolution | Example |
|--------|-----------|---------|
| Describes a bug/workaround that should be fixed properly | **Fix** | "bun test ≠ bun run test" → fix hook or docs |
| Cross-cutting insight not yet in permanent docs | **Promote** | CI finding → CLAUDE.md |
| Agent/domain-specific knowledge in global memory | **Relocate** | API pattern → domain CLAUDE.md |
| References #NNN, PR, branch, worktree path | **Delete** | Ephemeral context |
| References file/workflow that ∄ on disk | **Delete** | Stale |
| Already exists in discovered Π targets | **Delete** | Redundant |
| Tool version or env-specific value | **Delete** (or Fix) | Likely stale |

Verify ∀ ε:
```bash
# Referenced paths exist?
test -f "<path from ε>" && echo "EXISTS" || echo "STALE"

# Already in permanent docs? Search all discovered Π targets
grep -rl "<key phrase>" CLAUDE.md $(find . -maxdepth 3 -name "CLAUDE.md") .claude/agents/*.md 2>/dev/null
```

### Phase 3 — Present Resolution Plan

```
ε                              │ Resolution │ Target                        │ Recur │ Reason
───────────────────────────────┼────────────┼───────────────────────────────┼───────┼──────────────
CI --allowed-tools finding     │ Promote    │ CLAUDE.md                     │ 1st   │ Cross-cutting
Worktree pattern               │ Delete     │ —                             │ 1st   │ Already in CLAUDE.md
API auth edge case             │ Relocate   │ apps/api/CLAUDE.md            │ 2nd ⚠️│ Reappeared
bun test footgun               │ Fix        │ docs/testing.mdx              │ 1st   │ Root cause fix
Worktree #389 path             │ Delete     │ —                             │ 1st   │ Ephemeral
```

AskUserQuestion:
- **Execute all** (apply all resolutions)
- **1-by-1** (per-ε approve/change resolution)
- **Skip** (no changes)

### Phase 4 — Execute

∀ approved ε, in order:

1. **Fix**: make the code/config change, not just delete
2. **Promote**: append content to target file (respect existing structure)
3. **Relocate**: append content to scoped target
4. **Delete**: remove from μ/τ/α

After all resolutions applied → delete ε from μ/τ/α.

### Phase 5 — Log

Append audit entry to λ (`.claude/memory-audit-log.md`, create if not exists):

```markdown
## Audit <YYYY-MM-DD>

| ε | Source | Resolution | Target | Recurrence |
|---|--------|-----------|--------|------------|
| ... | ... | ... | ... | Nth |

Summary: <N> fixed, <N> promoted, <N> relocated, <N> deleted
Recurrences: <N> (details)
```

### Phase 6 — Verify Zero + Report

Report:
```
Memory Audit Complete
  Before: <N> entries, <N> lines
  After:  <N> entries, <N> lines
  ─────────────────────────────
  Fixed:     <N> (code/config changes made)
  Promoted:  <N> (→ permanent docs)
  Relocated: <N> (→ scoped targets)
  Deleted:   <N> (ephemeral/stale/redundant)
  ─────────────────────────────
  Recurrences: <N> ⚠️ (fix didn't stick)
  Systemic:    <N> 🔴 (3rd+ occurrence)
  Target: μ = 0
```

μ + τ + α still have content → report remaining ε as blockers.

μ = 0 ∧ |τ| = 0 ∧ |α| = 0 → "Memory fully drained."

## When to Run

- `/memory-audit` anytime
- After shipping a feature (ephemeral context likely stale)
- After cleaning branches (worktree refs likely stale)
- Proactively when |ε| > 5 or μ > 50 lines

$ARGUMENTS
