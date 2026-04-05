---
name: spec
argument-hint: '[--issue <N> | --analysis <path> | --frame <path> | --audit]'
description: Solution spec — acceptance criteria, breadboard, slices. Triggers: "write spec" | "spec this" | "solution design" | "what will we build" | "design the solution" | "acceptance criteria" | "define acceptance criteria" | "spec it out" | "write the spec".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill, ToolSearch
---

# Spec

Let:
  α := artifacts/analyses/{N}-{slug}-analysis.mdx
  σ := artifacts/specs/{N}-{slug}-spec.mdx
  φ := artifacts/frames/{slug}-frame.mdx
  ρ := reviewer set
  χ := `[NEEDS CLARIFICATION]`
  Ω := `skill: "interview"`
  Q := Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`
  SRC := source doc (α ∨ φ)

Analysis (or frame) → approved spec. Interview → pre-check → expert review → user approval.
¬worktree, ¬PR. Shape phase only. Implementation → `/plan`.

## Entry

```
/spec --issue N          → find analysis for #N (or frame if analysis skipped)
/spec --analysis path    → use provided analysis as source
/spec --frame path       → use provided frame (analysis was skipped)
```

## Step 0 — Resolve Input + Ensure GitHub Issue

### 0a. Resolve SRC

`--issue N` → scan priority order:
```bash
# 1. Find analysis with matching issue number
ls artifacts/analyses/{N}-*.mdx 2>/dev/null | head -1
# 2. Find frame with matching issue in frontmatter
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
```

`--analysis path` / `--frame path` → read directly.
¬SRC found → Q: "Run `/analyze --issue N` first, or provide path directly?"

Read SRC → extract: title, issue#, tier, problem, outcome, appetite, recommended shape (if α).

### 0b. Ensure GitHub Issue

∃ issue (`--issue N` ∨ found in SRC frontmatter) → use it.
¬∃ issue → draft from SRC:

```bash
gh issue create --title "<title>" --body "<body>"
# body: ## Problem\n{problem}\n\n## Outcome\n{outcome}
```

Capture returned issue #N.

## Step 1 — Scan Existing Spec

Glob `artifacts/specs/{N}-*`, `artifacts/specs/*{slug}*`.
∃ σ → Q: **Reuse existing** (→ Step 3) | **Start fresh**

## Step 1b — Reasoning Audit (optional)

`--audit` → after reading SRC, present reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md) (spec guidance).
→ Q: **Proceed** | **Adjust approach** | **Abort**
¬`--audit` → skip to Step 2.

## Step 2 — Generate Spec

`Ω, args: "--promote artifacts/analyses/{N}-{slug}-analysis.mdx"` (or frame path if no α).

Interview pre-fills from SRC. Focus on gaps to spec level:
- Acceptance criteria (binary pass/fail)
- Breadboard: affordance tables (UI/API elements → handlers → data)
- Slices: vertical increments, independently demo-able
- Ambiguity detection via 9-category taxonomy (see interview SKILL.md)

Write σ. Must include:

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

`## Data Model & Consumers` must include:
1. **Data structure diagram** (`classDiagram`) — core types/models, fields, relationships. Frozen/mutable annotations where relevant.
2. **Consumer map** (`flowchart`) — who consumes data, which fields, when. Solid = this issue, dashed = future (out of scope but fields must be accessible).
3. **Consumer summary table** — consumer → fields consumed, when, status (this issue / future).

Diagrams go BEFORE Breadboard. They answer "what is the data shape and who uses it" while Breadboard answers "how do pieces wire together."

May contain χ (max 3–5). χ items block `/plan` — must be resolved first.

## Step 3 — Pre-check

"Unit tests for English" — run before expert review:

| Check | Rule | Skip condition |
|-------|------|----------------|
| Testable criteria | Each `- [ ]` item is binary (pass/fail) | — |
| No dangling refs | All breadboard IDs (U*/N*/S*) appear in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Ambiguity budget | ≤5 χ items | — |
| Slice coverage | Every affordance appears in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Edge completeness | Each edge case has handling strategy | — |

≥2 failures → inform user:
```
Pre-check: 2 of 5 checks failed
  ✗ Testable criteria: "The UI should feel fast" is not binary
  ✗ Ambiguity budget: 7 [NEEDS CLARIFICATION] items found (max 5)
```

Q: **Fix spec first** (open σ, collect corrections, revise, re-check) | **Continue to review anyway**

## Step 4 — Expert Review

Auto-select ρ (¬ask user). Architect always included:

| ρ | When | Focus |
|---|------|-------|
| architect | Always | Technical soundness, feasibility, slice ordering |
| doc-writer | Always | Structure, clarity, breadboard completeness |
| product-lead | Always | Criteria quality, scope, user story validity |
| devops | ∃ CI/CD / deploy / infra criteria | Operational feasibility |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "<r>", prompt: "Review σ for <focus>. Check pre-check results. Return: good / needs improvement / concerns.")`.

Incorporate feedback → revise σ → note unresolved concerns.

## Step 5 — User Approval

Open σ: `code artifacts/specs/{N}-{slug}-spec.mdx`.

Present summary: scope, |slices|, |acceptance criteria|, |χ|, pre-check results, unresolved expert concerns.

Q: **Approve** → continue pipeline | **Revise** → collect feedback → revise σ → loop from Step 3.

On approval → commit: `git add artifacts/specs/{N}-{slug}-spec.mdx` + commit per CLAUDE.md Rule 5.

Run Gate 2.5 → update issue status:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Specs
```

∄ sub-issues → "Spec complete. Run `/plan --issue <N>` to generate the implementation plan."
∃ sub-issues → "Run `/plan --issue <sub_N>` for each sub-issue in dependency order."

## Gate 2.5: Smart Splitting (Optional)

Tier S → skip. Read [references/smart-splitting.md](${CLAUDE_SKILL_DIR}/references/smart-splitting.md).

**Triggers:** |acceptance criteria| > 8 ∨ |slices| > 3.
- Acceptance criteria := `- [ ]` checkboxes in `## Success Criteria`
- Slices := rows in `## Slices` table

¬triggers ∧ ¬both sections present → skip.
∃ triggers → run smart splitting per reference doc.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬α ∧ ¬φ found | Q: run `/analyze` first or provide path |
| ∃ σ, user picks reuse | Present existing → jump to Step 3 |
| Analysis skipped (F-lite) | Use frame as SRC for interview promotion |
| `--issue N` ∧ ¬GitHub issue | Create issue from SRC content |
| Expert subagent fails | Report error, continue without that reviewer |
| All pre-checks fail | Strongly recommend fix before review (¬block, user decides) |
| |χ| > 5 | Pre-check failure — inform, request reduction |
| Tier S | Skip Breadboard + Slices |
| Circular deps in split | Reject split proposal, inform user |

## Chain Position

- **Phase:** Shape
- **Predecessor:** `/analyze` (F-full) ∨ `/frame` (F-lite, analyze skipped)
- **Successor:** `/plan`
- **Class:** gate (user approval of spec artifact required)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Approved via `/dev`:** write artifact with `status: approved`, commit, return silently. ¬ask "proceed to /plan?". `/dev` re-scans and auto-chains to `/plan` in the same turn.
- **Approved standalone:** print one line: `Approved. Next: /plan --issue N`. Stop.
- **Modify requested:** loop in-skill, re-present.
- **Rejected/aborted:** return → `/dev` marks task `cancelled`.

$ARGUMENTS
