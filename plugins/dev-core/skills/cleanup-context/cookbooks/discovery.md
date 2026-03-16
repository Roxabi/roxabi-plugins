# Cookbook: Discovery

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  κ := 200 (MEMORY.md line cap)
  λ := .claude/context-audit-log.md (append-only audit log)
  Π := placement targets (auto-detected per project)

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

**Auto-discover Π** (run placement discovery script below).

## Placement Hierarchy

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
