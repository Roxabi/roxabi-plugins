---
name: analyze
argument-hint: '[--issue <N> | --frame <path>]'
description: Deep technical analysis — explore existing code, risks, alternatives. Triggers: "analyze" | "technical analysis" | "explore the problem" | "how deep is it".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Write, Edit, Glob, Grep, Task, Skill
---

# Analyze

Let:
  α := artifacts/analyses/{N}-{slug}.mdx
  φ := artifacts/frames/{slug}.mdx

Frame → analysis. Codebase exploration → expert review → user approval gate.
¬spec, ¬worktree. Shape phase only. Spec → `/spec`.

## Entry

```
/analyze --issue N    → read frame for #N, produce α
/analyze --frame path → read frame at path, produce α
```

## Step 0 — Resolve Input

Parse args → locate frame doc.

`--issue N`:
```bash
# Find frame by issue number in frontmatter or filename
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
# Fallback: glob by any slug
ls artifacts/frames/*.mdx 2>/dev/null
```

`--frame path` → read directly.

¬frame found → AskUserQuestion: "No frame doc found for this issue. Would you like to run `/frame --issue N` first, or provide the frame path directly?"

Read frame → extract: `title`, `issue`, `tier`, problem statement, constraints.

## Step 1 — Scan Existing Analysis

Glob `artifacts/analyses/*` — match issue# or slug keywords from frame.

∃ α:
- If `type: brainstorm` in frontmatter → treat as brainstorm (¬analysis), offer to promote.
- AskUserQuestion: **Reuse existing** (skip to [Step 3 Expert Review](#step-3--expert-review-1)) | **Start fresh**

## Step 2 — Codebase Exploration + Interview

### 2a. Glob + Grep

Based on frame problem + constraints, search codebase for related code:

```bash
# Find files relevant to the domain
# Examples (adapt to the actual problem):
Glob("apps/api/src/**/*.ts")     # backend domain
Glob("apps/web/src/**/*.tsx")    # frontend domain
Grep("keyword", type: "ts")     # symbol/pattern search
```

Read key files found (max 5–8 most relevant). Note: file paths, patterns, dependencies, risks.

### 2b. Interview

`skill: "interview", args: "topic text from frame"` (Analysis type).

Interview captures:
- **Source:** verbatim trigger (Slack message, ticket, quote)
- **Problem:** what is broken or missing
- **Outcome:** what success looks like without prescribing a solution
- **Appetite:** time budget (1 week, 2-week cycle, etc.)
- **Shapes:** 2–3 mutually exclusive architecture approaches — each with name, trade-offs, rough scope
- **Constraint alignment:** which constraints eliminate which shapes

Pre-fill context from frame doc — skip questions already answered.

## Step 2c — Generate Analysis

Write `artifacts/analyses/{N}-{slug}.mdx`:

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

Tier S may omit Shapes + Fit Check.

Spawn domain experts via Task during writing when a specific question arises. See [references/expert-consultation.md](references/expert-consultation.md).

## Step 2.5 — Investigation (Optional)

Skip if ¬technical uncertainty signals in Step 2 findings.

**Signals:** unfamiliar 3rd-party behavior, undocumented internal APIs, performance unknowns, conflicting docs.

∃ signals → AskUserQuestion: **Spike now** (create throwaway worktree, test hypothesis, report findings) | **Skip** (proceed to expert review).

**Spike flow:**
1. `git worktree add ../roxabi-spike-{N} -b spike/{N} staging`
2. Investigate: write minimal code, run isolated test, confirm/reject hypothesis
3. Report findings → incorporate into analysis
4. `git worktree remove ../roxabi-spike-{N}` (throwaway, ¬merge)

See [references/investigation.md](references/investigation.md) if the reference file exists, else proceed with inline flow above.

## Step 3 — Expert Review

Auto-select ρ (¬ask user):

| ρ | When | Focus |
|---|------|-------|
| doc-writer | Always | Structure, clarity |
| product-lead | Always | Product fit, Outcome quality, Problem↔Outcome alignment |
| architect | ∃ arch / trade-offs / multi-domain | Technical soundness, shape feasibility |
| devops | ∃ CI/CD / deploy / infra | Operational impact |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "<r>", prompt: "Review artifacts/analyses/{N}-{slug}.mdx for <focus>. Return: good / needs improvement / concerns.")`.

Incorporate feedback → revise α → note unresolved concerns.

## Step 4 — User Approval

Open α: `code artifacts/analyses/{N}-{slug}.mdx`.

Present summary: shapes found, trade-offs, recommended shape, unresolved concerns.

AskUserQuestion: **Approve** → update issue status → done | **Revise** → collect feedback → revise α → loop from [Step 3 Expert Review](#step-3--expert-review-1).

On approval → commit artifact: `git add artifacts/analyses/{N}-{slug}.mdx` + commit per CLAUDE.md Rule 5.

Update issue status:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Analysis
```

Inform: "Analysis complete. Run `/spec --issue <N>` to generate the solution spec."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No frame found | AskUserQuestion: run `/frame` first or provide path |
| ∃ brainstorm (¬analysis) | Treat as "no analysis" — offer to promote via interview |
| ∃ analysis, user picks reuse | Present existing analysis → jump to Step 3 Expert Review (skip Step 2) |
| Expert reviewer subagent fails | Report error, continue without that reviewer |
| Tier S | Skip Shapes + Fit Check in generated analysis |
| Frame lacks appetite | Ask user during interview Phase 1 |

$ARGUMENTS
