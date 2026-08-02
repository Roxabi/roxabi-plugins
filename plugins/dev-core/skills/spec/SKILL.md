---
name: spec
argument-hint: '[--issue <N> | --analysis <path> | --frame <path> | --audit]'
description: Solution spec — acceptance criteria, breadboard, slices. Triggers: "write spec" | "spec this" | "solution design" | "what will we build" | "design the solution" | "acceptance criteria" | "define acceptance criteria" | "spec it out" | "write the spec".
version: 0.3.1
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill, ToolSearch
---

# Spec

## Success

I := σ written ∧ pre-check reported ∧ executive summary shown ∧ (approved → committed)
V := `ls artifacts/specs/{N}-*.md*` ∧ (on approve) `status: approved` ∧ commit ∃

Let:
  α := artifacts/analyses/{N}-{slug}-analysis.md
  σ := artifacts/specs/{N}-{slug}-spec.md
  φ := artifacts/frames/{slug}-frame.md
  ρ := reviewer set
  χ := `[NEEDS CLARIFICATION]`
  SRC := source doc (α ∨ φ)

Analysis (or frame) → draft σ → **executive summary in chat** → free-form human reaction → approve/revise.
¬worktree, ¬PR. Shape phase only. Implementation → `/plan`.

## Hard ban — AskUserQuestion

**Never call AskUserQuestion / `present choice` / multi-select tool prompts in this skill.**

Human-in-the-loop is **chat-native**:
1. Produce the work.
2. Print a clear **Executive Summary**.
3. **Stop this turn** and wait for the user's free-form reply.
4. Interpret natural language (approve / change X / question / re-spec) and act.

No button menus. No forced option lists. If something is missing, write it into the summary or as χ — do not quiz via AQ.

## Entry

```
/spec --issue N          → find analysis for #N (or frame if analysis skipped)
/spec --analysis path    → use provided analysis as source
/spec --frame path       → use provided frame (analysis was skipped)
/spec --issue N --audit  → print reasoning audit as prose, then continue (¬AQ)
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 0 | resolve | ✓ | SRC ∃ | prose stop if missing |
| 1 | scan | — | σ ∃? | auto path — ¬AQ |
| 1b | audit | — | — | `--audit` only; prose, ¬AQ |
| 2 | generate | ✓ | σ written | from SRC; ¬interactive interview |
| 3 | pre-check | ✓ | report printed | auto-fix when cheap; else note in summary |
| 4 | review | — | agents return | ∥ spawn; auto-select ρ |
| 5 | summary | ✓ | exec summary shown | **stop turn** — wait for chat |
| 6 | react | ✓ | free-form | approve → commit; else revise loop |

## Pre-flight

Success: σ written ∧ executive summary shown ∧ (on approve) committed
Evidence: `ls artifacts/specs/` + chat summary + optional commit
Steps: resolve → generate → pre-check → review → executive summary → chat react
¬clear → STOP with prose: "What artifact should this spec derive from? Pass `--analysis` / `--frame` / `--issue`."

## Step 0 — Resolve Input + Ensure GitHub Issue

### 0a. Resolve SRC

`--issue N` → scan priority order:
```bash
# 1. Find analysis with matching issue number
ls artifacts/analyses/{N}-*.md* 2>/dev/null | head -1
# 2. Find frame with matching issue in frontmatter
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
```

`--analysis path` / `--frame path` → read directly.
¬SRC found → **stop** with prose (not AQ):
```
No analysis/frame found for #{N}.
Run /analyze --issue N (or /frame), or re-run with --analysis <path> / --frame <path>.
```

Read SRC → extract: title, issue#, tier, **problem/intent**, outcome, appetite, recommended shape (if α).
- Intent (SRC Problem) → σ `## Intent` + exec summary **Solve**
- Outcome → σ `## Goal` + exec summary **Done when**
- Problem empty/sparse → Intent from title + outcome (1–2 lines), or χ if still unclear — ¬invent a problem SRC never stated

### 0b. Ensure GitHub Issue

∃ issue (`--issue N` ∨ found in SRC frontmatter) → use it.
¬∃ issue → create from SRC (auto — no ask):

```bash
gh issue create --title "<title>" --body "<body>"
# body: ## Problem\n{problem}\n\n## Outcome\n{outcome}
```

Capture returned issue #N. Print one line: `Created issue #N.`

## Step 1 — Scan Existing Spec

Glob `artifacts/specs/{N}-*`, `artifacts/specs/*{slug}*`.

| State | Action |
|-------|--------|
| ∃ σ ∧ `status: approved` | **Reuse.** Print short note + **lean Executive Summary** (Step 5 structure + hard caps) of existing σ → Step 5/6 (chat: approve to keep & continue pipeline, or "re-spec" / changes). ¬regenerate unless user asks. |
| ∃ σ ∧ draft / no status | Load as base → Step 2 refine (fill gaps, re-check) |
| ¬∃ σ | Step 2 generate fresh |

## Step 1b — Reasoning Audit (optional)

`--audit` → print reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md) as **prose in chat**. Continue to Step 2. ¬AQ Proceed/Adjust/Abort — user can interrupt in the next turn if they disagree.

¬`--audit` → skip to Step 2.

## Step 2 — Generate Spec

**¬invoke interactive `/interview`.** Promote SRC → σ in this skill: pre-fill everything clear from SRC; mark unknowns as χ (max 3–5). Use the 9-category ambiguity taxonomy from interview as a silent checklist (Functional Scope, Domain & Data, UX, NFR, Integrations, Edge Cases, Constraints, Terminology, Completion Signals) — do not fire interview AQs.

Focus content:
- Acceptance criteria (binary pass/fail)
- Breadboard: affordance tables (UI/API elements → handlers → data)
- Slices: vertical increments, independently demo-able
- χ only where SRC is truly silent

Write σ with `status: draft`. Must include:

| Section | Skip if |
|---------|---------|
| `## Context` — source + promoted-from link | — |
| `## Intent` — what we seek to solve (pain / gap / broken invariant) + why now | — |
| `## Goal` — one-sentence observable outcome | — |
| `## Users` — who is affected | — |
| `## Expected Behavior` — narrative walkthrough | — |
| `## Data Model & Consumers` — prose types + optional consumer table (markdown only) | Tier S |
| `## Breadboard` — affordance tables + wiring | Tier S |
| `## Slices` — vertical increments table | Tier S |
| `## Success Criteria` — `- [ ]` checkboxes, each binary | — |

**Intent ≠ Goal.** Intent = *why / what problem*. Goal = *done-when*. Never collapse into one sentence.

### Data Model & Consumers (Tier F-lite, F-full)

Markdown only — **¬** forge-chart HTML sidecars, **¬** required `artifacts/visuals/*-data-model.html` / `*-consumers.html`.

Include when data shape matters:
1. **Data structure** — core types/models, fields, relationships; note frozen vs mutable where useful
2. **Consumers** (optional table) — who consumes which fields, when, status (this issue / future)

Section sits before Breadboard: shape of data vs how pieces wire together.

May contain χ (max 3–5). χ items block `/plan` — must be resolved before plan (via chat revise, not AQ).

## Step 3 — Pre-check

"Unit tests for English" — run before expert review:

| Check | Rule | Skip condition |
|-------|------|----------------|
| Testable criteria | Each `- [ ]` item is binary (pass/fail) | — |
| No dangling refs | All breadboard IDs (U*/N*/S*) appear in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Ambiguity budget | ≤5 χ items | — |
| Slice coverage | Every affordance appears in ≥1 slice | ¬Breadboard ∨ ¬Slices |
| Edge completeness | Each edge case has handling strategy | — |

**Auto-fix** cheap failures when obvious (rephrase non-binary criteria into binary, add missing slice rows for orphan IDs). Re-run checks once after auto-fix.

Remaining failures → list in Executive Summary under **Pre-check** (do not AQ Fix/Continue). Prefer fixing over shipping a broken draft when the fix is unambiguous.

## Step 4 — Expert Review

Auto-select ρ (¬ask user). Architect always included:

| ρ | When | Focus |
|---|------|-------|
| architect | Always | Technical soundness, feasibility, slice ordering |
| doc-writer | Always | Structure, clarity, breadboard completeness |
| product-lead | Always | Criteria quality, scope, user story validity |
| adversarial | Always | Red-team: scope-attack, vacuous AC, missing adversarial flows, assumption-kill, control bypass in proposed design |
| devops | ∃ CI/CD / deploy / infra criteria | Operational feasibility |
| axial-adr-review | ∃ axial ADR (`axial: true` ∈ `docs/architecture/adr/`) ∧ (spec adds adapter/integration/target ∨ touches `infrastructure/`) | Drift along non-primary axis (N×M trap) — read-only review |

> **Note on axial-adr-review asymmetry (intentional):** The `/spec` condition is **semantic/intent-based** — it triggers when the spec proposes adding a new adapter/integration/target or touches `infrastructure/`. The code-review phase (`/code-review`) uses a **structural** condition (diff touches `infrastructure/`, `adapters/`, `domains/`, or `stages/`). The two are complementary: `/spec` catches intent-level N×M violations, `/code-review` catches implementation-level ones. See `plugins/shared/references/axial-decomposition.md`.

∀ r ∈ ρ → spawn ∥:
```
Task(
  subagent_type: "dev-core:<r>",
  description: "<r> spec review — #{N}",
  prompt: "Review the spec at {σ_path} for <focus>. Check pre-check results: {pre_check_summary}. ¬TaskCreate. Return: good / needs improvement / concerns + specific line references."
)
```
Agent name map: `architect` → `dev-core:architect` | `doc-writer` → `dev-core:doc-writer` | `product-lead` → `dev-core:product-lead` | `adversarial` → `dev-core:adversarial` | `devops` → `dev-core:devops` | `axial-adr-review` → `dev-core:axial-adr-review`

Incorporate high-confidence feedback into σ. Unresolved expert concerns → list in Executive Summary (not AQ).

## Step 5 — Executive Summary (always)

Open σ for the user: `code artifacts/specs/{N}-{slug}-spec.md` (or print path if `code` unavailable).

Print **exactly this structure** (fill from σ + Steps 3–4). HITL surface — **scannable in ≤30s**, not a paste of σ.

**Hard size caps (enforce):**
- Intent block: ≤4 short lines total
- Scope In / Out: ≤4 / ≤3 one-line bullets
- Criteria: first **5** only; if more → `+{n} in file`
- Experts: ≤3 bullets or `clean`
- Forbidden in summary: Expected Behavior narrative, breadboard tables, full criteria dump

```markdown
## Spec — Executive Summary

**#{N}** — {title}
`artifacts/specs/{N}-{slug}-spec.md` · **{τ}** · draft · src `{α|φ short path}`

### Intent
**Solve:** {1–2 sentences — pain / gap / broken invariant we fix; why now}
**Done when:** {Goal — one observable outcome sentence}
**Today → Target:** {optional one-liner each; omit if obvious}

### Scope
- **In:** {≤4 one-line bullets}
- **Out:** {≤3 one-line bullets, or "—"}
- **Who:** {primary (+ secondary) — one line}

### Delivery
| # | Slice | Demo |
|---|-------|------|
| V1 | … | … |

(or "— (Tier S)" )

**Criteria ({n}):** 1) … 2) … 3) … 4) … 5) … {if n>5: `+{n-5} in file`}
**χ ({n}):** {each short, or "none"}

### Gates
**Pre-check:** {pass | fail — ≤3 bullets}
**Experts:** {clean | ≤3 unresolved}
**Data model:** {1–2 lines from §Data Model & Consumers, or "—"}

---
**Your move (free text — no menu):**
approve / ok → commit + mark approved · change … → revise + re-print · question … → answer · re-spec · split
```

**STOP this turn** after printing the summary. Do not commit. Do not invoke `/plan`. Do not AskUserQuestion.

## Step 6 — React (free-form chat)

On the user's next message, interpret intent (no AQ):

| Intent signals (examples) | Action |
|---------------------------|--------|
| approve, ok, LGTM, ship, good, go, looks good, approved | → **Approve path** |
| change / revise / drop / add / tighten / rewrite … | Edit σ → re-run cheap pre-check → re-print Executive Summary → **stop again** |
| question / why / what about / clarify … | Answer in chat; revise σ only if they also request a change |
| re-spec / start over / regenerate | Wipe draft content, re-run from Step 2 |
| split / sub-issues | Run Gate 2.5 proposal **as prose** in chat; create only if they confirm in free text |
| abort / stop / cancel | Stop; leave draft on disk; return cancel to `/dev` if applicable |

Ambiguous free text → ask **one short prose clarifying question** in the message (plain text). Still ¬AskUserQuestion.

### Approve path

1. Set frontmatter `status: approved` via Edit.
2. Commit: `git add artifacts/specs/{N}-{slug}-spec.md` + commit per CLAUDE.md Rule 5.
3. Run Gate 2.5 only if triggers fire **and** user already said "split" — otherwise skip (do not force-split).
4. Update issue status:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Specs
```
5. Exit per Exit section.

## Gate 2.5: Smart Splitting (optional, chat-only)

Tier S → skip. Read [references/smart-splitting.md](${CLAUDE_SKILL_DIR}/references/smart-splitting.md).

**Triggers:** |acceptance criteria| > 8 ∨ |slices| > 3.

On trigger at approve time: **mention once** in the post-approve message as optional next step ("Say 'split' if you want sub-issues"). ¬auto-create. ¬AQ menu.

When user says split: present proposal as prose table → wait free-form confirm → then create. See smart-splitting.md (chat mode).

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬α ∧ ¬φ found | Prose stop + how to provide SRC |
| ∃ approved σ | Reuse + exec summary; re-spec on request |
| Analysis skipped (F-lite) | Use frame as SRC |
| `--issue N` ∧ ¬GitHub issue | Create issue from SRC (auto) |
| Expert subagent fails | Report in Expert notes; continue |
| Pre-check still failing | List in summary; user can still approve (warn) or request fixes |
| \|χ\| > 5 | Reduce during generate; leftover listed in summary |
| Tier S | Skip Breadboard + Slices |
| Circular deps in split | Reject split proposal in prose |

## Chain Position

- **Phase:** Shape
- **Predecessor:** `/analyze` (F-full) ∨ `/frame` (F-lite, analyze skipped)
- **Successor:** `/plan`
- **Class:** gate — **chat executive summary**, not AskUserQuestion

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **While waiting for reaction:** turn ends after Executive Summary. Task stays in progress from `/dev`'s POV until approve/abort.
- **Approved via `/dev`:** commit, return silently. ¬ask "proceed to /plan?" via AQ. `/dev` re-scans and auto-chains to `/plan` in the same turn **after** the approve message is processed.
- **Approved standalone:** print one line: `Approved. Next: /plan --issue N`. Stop.
- **Revise loop:** re-print Executive Summary after each edit; stop again.
- **Abort:** return → `/dev` marks task `cancelled`.

$ARGUMENTS
