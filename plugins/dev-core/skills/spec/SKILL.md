---
name: spec
argument-hint: '[--issue <N> | --analysis <path> | --frame <path>]'
description: Solution spec — acceptance criteria, breadboard, slices. Triggers: "write spec" | "spec this" | "solution design" | "what will we build".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Write, Edit, Glob, Grep, Task, Skill
---

# Spec

Let:
  α := artifacts/analyses/{N}-{slug}.mdx
  σ := artifacts/specs/{N}-{slug}.mdx
  φ := artifacts/frames/{slug}.mdx

Analysis (or frame) → approved spec. Interview → pre-check → expert review → user approval gate.
¬worktree, ¬PR. Shape phase only. Implementation → `/plan`.

## Entry

```
/spec --issue N          → find analysis for #N (or frame if analysis skipped)
/spec --analysis path    → use provided analysis as source
/spec --frame path       → use provided frame (analysis was skipped)
```

## Step 0 — Resolve Input + Ensure GitHub Issue

### 0a. Resolve source document

`--issue N` → scan in priority order:
```bash
# 1. Find analysis with matching issue number
ls artifacts/analyses/{N}-*.mdx 2>/dev/null | head -1
# 2. Find frame with matching issue in frontmatter
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
```

`--analysis path` → read analysis directly.
`--frame path` → read frame directly (analysis was skipped for this tier).

¬source found → AskUserQuestion: "No analysis or frame found for this issue. Would you like to run `/analyze --issue N` first, or provide a path directly?"

Read source doc → extract: title, issue number, tier, problem, outcome, appetite, recommended shape (if analysis).

### 0b. Ensure GitHub Issue

∃ issue (`--issue N` or found in source frontmatter) → use it.
¬∃ issue → draft from source doc:

```bash
gh issue create --title "<title>" --body "<body>"
# body: ## Problem\n{problem}\n\n## Outcome\n{outcome}
```

Capture returned issue #N.

## Step 1 — Scan Existing Spec

Glob `artifacts/specs/{N}-*`, `artifacts/specs/*{slug}*` — match issue# or slug keywords.

∃ σ → AskUserQuestion: **Reuse existing** (jump to [Step 3 Pre-check](#step-3--pre-check)) | **Start fresh**

## Step 2 — Generate Spec

`skill: "interview", args: "--promote artifacts/analyses/{N}-{slug}.mdx"` (or frame path if no analysis).

Interview pre-fills from source. Focus on gaps to spec level:
- Acceptance criteria (binary pass/fail)
- Breadboard: affordance tables (UI/API elements → handlers → data)
- Slices: vertical increments that are independently demo-able
- Ambiguity detection via 9-category taxonomy (see interview SKILL.md)

Write `artifacts/specs/{N}-{slug}.mdx`.

σ must include:
- `## Context` — source + promoted-from link
- `## Goal` — one-sentence outcome
- `## Users` — who is affected
- `## Expected Behavior` — narrative walkthrough
- `## Breadboard` — affordance tables + wiring (skip if Tier S)
- `## Slices` — vertical increments table (skip if Tier S)
- `## Success Criteria` — `- [ ]` checkboxes, each binary

May contain `[NEEDS CLARIFICATION: description]` (max 3–5). These block `/plan` — must be resolved first.

## Step 3 — Pre-check

"Unit tests for English" — run before expert review. Check all:

| Check | Rule | Skip condition |
|-------|------|----------------|
| Testable criteria | Each `- [ ]` item is binary (pass/fail) | — |
| No dangling refs | All breadboard IDs (U*/N*/S*) appear in ≥1 slice | ¬Breadboard ∨ ¬Slices sections |
| Ambiguity budget | ≤5 `[NEEDS CLARIFICATION]` items | — |
| Slice coverage | Every affordance appears in ≥1 slice | ¬Breadboard ∨ ¬Slices sections |
| Edge completeness | Each edge case has a handling strategy | — |

Count failures. ≥2 failures → inform user before review:

```
Pre-check: 2 of 5 checks failed
  ✗ Testable criteria: "The UI should feel fast" is not binary
  ✗ Ambiguity budget: 7 [NEEDS CLARIFICATION] items found (max 5)
```

AskUserQuestion: **Fix spec first** (open σ, collect corrections, revise, re-check) | **Continue to review anyway**

## Step 4 — Expert Review

Auto-select ρ (¬ask user). Architect always included for specs:

| ρ | When | Focus |
|---|------|-------|
| architect | Always | Technical soundness, implementation feasibility, slice ordering |
| doc-writer | Always | Structure, clarity, breadboard completeness |
| product-lead | Always | Criteria quality, scope, user story validity |
| devops | ∃ CI/CD / deploy / infra criteria | Operational feasibility |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "<r>", prompt: "Review artifacts/specs/{N}-{slug}.mdx for <focus>. Check pre-check results. Return: good / needs improvement / concerns.")`.

Incorporate feedback → revise σ → note unresolved concerns.

## Step 5 — User Approval

Open σ: `code artifacts/specs/{N}-{slug}.mdx`.

Present summary: scope, slices count, acceptance criteria count, `[NEEDS CLARIFICATION]` count, pre-check results, unresolved expert concerns.

AskUserQuestion: **Approve** → continue pipeline | **Revise** → collect feedback → revise σ → loop from [Step 3 Pre-check](#step-3--pre-check).

On approval → commit artifact: `git add artifacts/specs/{N}-{slug}.mdx` + commit per CLAUDE.md Rule 5.

Run [Gate 2.5 Smart Splitting](#gate-25-smart-splitting-optional) → update issue status → done.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Specs
```

Inform: "Spec complete. Run `/plan --issue <N>` to generate the implementation plan."
Sub-issues created → "Run `/plan --issue <sub_N>` for each sub-issue in dependency order."

## Gate 2.5: Smart Splitting (Optional)

Skip if Tier S. Read [references/smart-splitting.md](references/smart-splitting.md).

**Triggers:** |acceptance criteria| > 8 ∨ |slices| > 3.

Count:
- Acceptance criteria: `- [ ]` checkboxes in `## Success Criteria`
- Slices: rows in `## Slices` table

¬triggers ∧ ¬both sections present → skip.
∃ triggers → run smart splitting per reference doc.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No analysis or frame found | AskUserQuestion: run `/analyze` first or provide path |
| ∃ spec, user picks reuse | Present existing spec → jump to Step 3 Pre-check |
| Analysis was skipped (F-lite) | Use frame as source for interview promotion |
| `--issue N` but no GitHub issue exists | Create issue from source doc content |
| Expert reviewer subagent fails | Report error, continue without that reviewer |
| All pre-checks fail | Strongly recommend fix before review (¬block, user decides) |
| `[NEEDS CLARIFICATION]` count > 5 | Pre-check failure — inform user, request reduction |
| Tier S | Skip Breadboard + Slices in generated spec |
| Circular deps in split | Reject split proposal, inform user |

$ARGUMENTS
