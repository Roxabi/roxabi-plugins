---
name: analyze
argument-hint: '[--issue <N> | --frame <path>]'
description: Deep technical analysis — explore existing code, risks, alternatives. Triggers: "analyze" | "technical analysis" | "explore the problem" | "how deep is it" | "deep dive" | "investigate this" | "analyze this feature" | "what are the risks" | "explore the codebase" | "look into this".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, Skill, ToolSearch
---

# Analyze

## Success

I := α written ∧ committed ∧ shapes ∃
V := `git log --oneline -1 | grep analysis` ∧ `ls artifacts/analyses/{N}-*.mdx`

Let:
  α := artifacts/analyses/{N}-{slug}-analysis.mdx
  φ := artifacts/frames/{slug}-frame.mdx
  ρ := expert reviewer set
  Ω := `skill: "interview"`
  Q := decision presentation (Pattern A — read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`)

Frame → analysis. Codebase exploration → expert review → user approval gate.
¬spec, ¬worktree. Shape phase only. Spec → `/spec`.

## Entry

```
/analyze --issue N    → read frame for #N, produce α
/analyze --frame path → read frame at path, produce α
```

## Step 0 — Resolve Input

Parse args → locate φ.

`--issue N`:
```bash
# Find frame by issue number in frontmatter or filename
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
# Fallback: glob by any slug
ls artifacts/frames/*.mdx 2>/dev/null
```

`--frame path` → read directly.
¬φ found → → DP(B) "No frame doc found. Run `/frame --issue N` first, or provide path directly?"

Read φ → extract: `title`, `issue`, `tier`, problem statement, constraints.

## Step 1 — Scan Existing Analysis

Glob `artifacts/analyses/*` — match issue# or slug from φ.

∃ α:
- `type: brainstorm` ∈ frontmatter → treat as brainstorm (¬analysis), offer to promote.
- → DP(A) **Reuse existing** (→ Step 3) | **Start fresh**

## Step 2 — Codebase Exploration + Interview

### 2a. Glob + Grep

Search codebase based on φ problem + constraints:

```bash
# Find files relevant to the domain (adapt to actual problem):
Glob("{backend.path}/src/**/*.ts")    # backend domain
Glob("{frontend.path}/src/**/*.tsx")  # frontend domain
Grep("keyword", type: "ts")           # symbol/pattern search
```

Read key files (max 5–8 most relevant). Note: paths, patterns, dependencies, risks.

### 2b. Interview

`Ω, args: "topic text from frame"` (Analysis type).

Captures: source (verbatim trigger) | problem (broken/missing) | outcome (success ¬prescribing solution) | appetite (time budget) | shapes (2–3 mutually exclusive arch approaches: name + trade-offs + scope) | constraint alignment (which constraints eliminate which shapes).

Pre-fill context from φ — skip answered questions.

## Step 2c — Generate Analysis

Write α:

```mdx
---
title: "{title}"
description: "{one-line description}"
---

## Source

{verbatim trigger — exact quote, ticket, Slack message}

## Problem

{what is broken or missing today, in plain language}

## Outcome

{what success looks like — without prescribing a solution}

## Appetite

{time budget — e.g. "1-week cycle", "2 sprints"}

## Shapes

### Shape 1: {name}

{description}

**Trade-offs:**
- Pro: ...
- Con: ...

**Rough scope:** {XS | S | M | L | XL}

### Shape 2: {name}

...

## Fit Check

{Which shape best fits constraints + appetite, and why. Which shapes are eliminated.}
```

### Mermaid Diagrams (optional, recommended for F-lite/F-full)

When analysis involves data flow or architectural choices, include mermaid in `## Fit Check` or `## Shapes`:
- **Shape comparison** (`flowchart`): show key structural differences visually
- **Data flow discovery** (`flowchart`): diagram current state for concrete findings
- **Files impacted** table: always include when ≥3 files touched

Tier S may omit Shapes + Fit Check.

∃ specific technical question → spawn domain expert via Task. See [references/expert-consultation.md](${CLAUDE_SKILL_DIR}/references/expert-consultation.md).

## Step 2.5 — Investigation (Optional)

Skip if ¬technical uncertainty in Step 2 findings.

**Signals:** unfamiliar 3rd-party behavior | undocumented internal APIs | performance unknowns | conflicting docs.

∃ signals → → DP(A) **Spike now** (throwaway worktree, test hypothesis) | **Skip** (→ expert review).

**Spike flow:**
1. `EnterWorktree(name: "spike-{N}")` — creates isolated throwaway worktree
2. Inside worktree: `git checkout -b spike/{N} origin/${BASE}` (where BASE = staging ∨ main)
3. Investigate: minimal code, isolated test, confirm/reject hypothesis
4. Report findings → incorporate into α
5. `ExitWorktree(action: "remove", discard_changes: true)` — clean up throwaway worktree

See [references/investigation.md](${CLAUDE_SKILL_DIR}/references/investigation.md) if ∃, else use inline flow above.

## Step 3 — Expert Review

Auto-select ρ (¬ask user):

| ρ | When | Focus |
|---|------|-------|
| doc-writer | Always | Structure, clarity |
| product-lead | Always | Product fit, Outcome quality, Problem↔Outcome alignment |
| architect | ∃ arch / trade-offs / multi-domain | Technical soundness, shape feasibility |
| devops | ∃ CI/CD / deploy / infra | Operational impact |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "<r>", prompt: "Review α for <focus>. Return: good / needs improvement / concerns.")`.

Incorporate feedback → revise α → note unresolved concerns.

## Step 4 — User Approval

Open α: `code artifacts/analyses/{N}-{slug}-analysis.mdx`.

Present summary: shapes found, trade-offs, recommended shape, unresolved concerns.

→ DP(A) **Approve** → update issue status → done | **Revise** → collect feedback → revise α → loop from Step 3.

On approval → commit: `git add artifacts/analyses/{N}-{slug}-analysis.mdx` + commit per CLAUDE.md Rule 5.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Analysis
```

Inform: "Analysis complete. Run `/spec --issue <N>` to generate the solution spec."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No frame found | → DP(B) run `/frame` first or provide path |
| ∃ brainstorm (¬analysis) | Treat as no analysis — offer to promote via interview |
| ∃ analysis, user picks reuse | Present existing → jump to Step 3 |
| Expert subagent fails | Report error, continue without that reviewer |
| Tier S | Skip Shapes + Fit Check |
| Frame lacks appetite | Ask user during interview Phase 1 |

## Chain Position

- **Phase:** Shape
- **Predecessor:** `/frame` (artifact: `artifacts/frames/{N}-{slug}-frame.mdx`)
- **Successor:** `/spec`
- **Class:** adv (continuous flow, no gate — user approves α inline in Step 4, not a pipeline gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Success via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce `/spec`. `/dev` re-scans and advances.
- **Success standalone:** print one line: `Done. Next: /spec --issue N`. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

$ARGUMENTS
