---
name: spec
argument-hint: '[--issue <N> | --analysis <path> | --frame <path> | --audit]'
description: Solution spec — acceptance criteria, breadboard, slices. Triggers: "write spec" | "spec this" | "solution design" | "what will we build".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill, ToolSearch, AskUserQuestion
---

# Spec

Let:
  α := artifacts/analyses/{N}-{slug}-analysis.mdx
  σ := artifacts/specs/{N}-{slug}-spec.mdx
  φ := artifacts/frames/{slug}-frame.mdx
  ρ := reviewer set
  χ := `[NEEDS CLARIFICATION]`

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

`--analysis path` → read directly. `--frame path` → read directly (analysis skipped for this tier).

¬source found → AskUserQuestion: "No analysis or frame found for this issue. Would you like to run `/analyze --issue N` first, or provide a path directly?"

Read source → extract: title, issue#, tier, problem, outcome, appetite, recommended shape (if analysis).

### 0b. Ensure GitHub Issue

∃ issue (`--issue N` ∨ found in source frontmatter) → use it.
¬∃ issue → draft from source doc:

```bash
gh issue create --title "<title>" --body "<body>"
# body: ## Problem\n{problem}\n\n## Outcome\n{outcome}
```

Capture returned issue #N.

## Step 1 — Scan Existing Spec

Glob `artifacts/specs/{N}-*`, `artifacts/specs/*{slug}*` — match issue# or slug keywords.

∃ σ → AskUserQuestion: **Reuse existing** (→ Step 3 Pre-check) | **Start fresh**

## Step 1b — Reasoning Audit (optional)

`--audit` flag → after reading source document (Step 0), present reasoning audit per [reasoning-audit.md](../shared/references/reasoning-audit.md) (spec guidance).

→ AskUserQuestion: **Proceed** | **Adjust approach** | **Abort**

¬`--audit` → skip to Step 2.

## Step 2 — Generate Spec

`skill: "interview", args: "--promote artifacts/analyses/{N}-{slug}-analysis.mdx"` (or frame path if no analysis).

Interview pre-fills from source. Focus on gaps to spec level:
- Acceptance criteria (binary pass/fail)
- Breadboard: affordance tables (UI/API elements → handlers → data)
- Slices: vertical increments, independently demo-able
- Ambiguity detection via 9-category taxonomy (see interview SKILL.md)

Write `artifacts/specs/{N}-{slug}-spec.mdx`. σ must include:

| Section | Skip if |
|---------|---------|
| `## Context` — source + promoted-from link | — |
| `## Goal` — one-sentence outcome | — |
| `## Users` — who is affected | — |
| `## Expected Behavior` — narrative walkthrough | — |
| `## Data Model & Consumers` — mermaid diagrams (see below) | Tier S |
| `## Breadboard` — affordance tables + wiring | Tier S |
| `## Slices` — vertical increments table | Tier S |
| `## Success Criteria` — `- [ ]` checkboxes, each binary | — |

### Mermaid Diagrams (Tier F-lite, F-full)

`## Data Model & Consumers` section must include:

1. **Data structure diagram** (`classDiagram`) — show core data types/models introduced or modified, with fields and relationships. Frozen/mutable annotations where relevant.

2. **Consumer map** (`flowchart`) — show who consumes the data, which fields they read, and when. Distinguish current consumers (solid lines, this issue) from future consumers (dashed lines, out of scope but fields must be accessible).

3. **Consumer summary table** — map each consumer to: fields consumed, when, status (this issue / future).

Diagrams go BEFORE the Breadboard section. They answer "what is the data shape and who uses it" while the Breadboard answers "how do the pieces wire together."

May contain χ (max 3–5). χ items block `/plan` — must be resolved first.

## Step 3 — Pre-check

"Unit tests for English" — run before expert review:

| Check | Rule | Skip condition |
|-------|------|----------------|
| Testable criteria | Each `- [ ]` item is binary (pass/fail) | — |
| No dangling refs | All breadboard IDs (U*/N*/S*) appear in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Ambiguity budget | ≤5 χ items | — |
| Slice coverage | Every affordance appears in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Edge completeness | Each edge case has a handling strategy | — |

≥2 failures → inform user:
```
Pre-check: 2 of 5 checks failed
  ✗ Testable criteria: "The UI should feel fast" is not binary
  ✗ Ambiguity budget: 7 [NEEDS CLARIFICATION] items found (max 5)
```

AskUserQuestion: **Fix spec first** (open σ, collect corrections, revise, re-check) | **Continue to review anyway**

## Step 4 — Expert Review

Auto-select ρ (¬ask user). Architect always included:

| ρ | When | Focus |
|---|------|-------|
| architect | Always | Technical soundness, feasibility, slice ordering |
| doc-writer | Always | Structure, clarity, breadboard completeness |
| product-lead | Always | Criteria quality, scope, user story validity |
| devops | ∃ CI/CD / deploy / infra criteria | Operational feasibility |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "<r>", prompt: "Review artifacts/specs/{N}-{slug}-spec.mdx for <focus>. Check pre-check results. Return: good / needs improvement / concerns.")`.

Incorporate feedback → revise σ → note unresolved concerns.

## Step 5 — User Approval

Open σ: `code artifacts/specs/{N}-{slug}-spec.mdx`.

Present summary: scope, |slices|, |acceptance criteria|, |χ|, pre-check results, unresolved expert concerns.

AskUserQuestion: **Approve** → continue pipeline | **Revise** → collect feedback → revise σ → loop from Step 3.

On approval → commit artifact: `git add artifacts/specs/{N}-{slug}-spec.mdx` + commit per CLAUDE.md Rule 5.

Run Gate 2.5 → update issue status → done:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Specs
```

∄ sub-issues → "Spec complete. Run `/plan --issue <N>` to generate the implementation plan."
∃ sub-issues → "Run `/plan --issue <sub_N>` for each sub-issue in dependency order."

## Gate 2.5: Smart Splitting (Optional)

Tier S → skip. Read [references/smart-splitting.md](references/smart-splitting.md).

**Triggers:** |acceptance criteria| > 8 ∨ |slices| > 3.
- Acceptance criteria := `- [ ]` checkboxes in `## Success Criteria`
- Slices := rows in `## Slices` table

¬triggers ∧ ¬both sections present → skip.
∃ triggers → run smart splitting per reference doc.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬analysis ∧ ¬frame found | AskUserQuestion: run `/analyze` first or provide path |
| ∃ spec, user picks reuse | Present existing spec → jump to Step 3 |
| Analysis was skipped (F-lite) | Use frame as source for interview promotion |
| `--issue N` ∧ ¬GitHub issue | Create issue from source doc content |
| Expert subagent fails | Report error, continue without that reviewer |
| All pre-checks fail | Strongly recommend fix before review (¬block, user decides) |
| |χ| > 5 | Pre-check failure — inform user, request reduction |
| Tier S | Skip Breadboard + Slices in generated spec |
| Circular deps in split | Reject split proposal, inform user |

$ARGUMENTS
