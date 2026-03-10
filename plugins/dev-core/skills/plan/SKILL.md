---
name: plan
argument-hint: '[--issue <N> | --spec <path> | --audit]'
description: Implementation plan — tasks, agents, file groups, dependencies. Triggers: "plan" | "plan this" | "implementation plan" | "break it down".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill, ToolSearch, AskUserQuestion
---

# Plan

Let:
  σ := spec artifact
  π := plan artifact at `artifacts/plans/{issue}-{slug}.mdx`
  τ := tier ∈ {S, F-lite, F-full}

Spec → micro-tasks → agent assignments → plan artifact.

**⚠ Flow: single continuous pipeline. ¬stop between steps. AskUserQuestion response → immediately execute next step. Stop only on: Cancel/Abort or Step 6 completion.**

```
/plan --issue 42         Generate plan from spec for issue #42
/plan --spec path        Generate plan from explicit spec path
/plan --issue 42 --audit Show reasoning checkpoint before planning
```

## Step 1 — Locate Spec

`--issue N` → `ls artifacts/specs/N-*.mdx` → read full → extract title, criteria, files.
`--spec <path>` → read directly.
¬found → suggest `/spec` or `/dev`. **Stop.**

### Pre-flight: Ambiguity Check

Grep `\[NEEDS CLARIFICATION` in σ (count).
count > 0 → AskUserQuestion: **Resolve now** | **Return to spec** | **Proceed anyway**

## Step 2 — Plan

Read `docs/processes/dev-process.mdx` + σ.

### Step 2a-pre — Reasoning Audit (optional)

`--audit` flag → after reading σ, present reasoning audit per [reasoning-audit.md](../shared/references/reasoning-audit.md) (plan guidance).

→ AskUserQuestion: **Proceed** | **Adjust approach** | **Abort**

¬`--audit` → continue to Step 2a.

**2a. Scope:** Glob + Grep → files to create/modify + reference features for patterns.

**2b. Tier:** S | F-lite | F-full per dev-process.mdx. ∃ `artifacts/frames/` ∧ `tier` field → use it. Else assess from σ complexity.

**2c. Agents:**

| Path prefix | Agent |
|------------|-------|
| `{frontend.path}`, `{shared.ui}` | frontend-dev |
| `{backend.path}`, `{shared.types}` | backend-dev |
| `{shared.config}`, root configs | devops |
| `docs/` | doc-writer |

Paths from stack.yml. ¬set → file domain heuristics (component/hook → FE; service/controller/route → BE).

Always: **tester**. Add: architect (new modules), security-auditor (auth/validation), doc-writer (new APIs).
Tier S → skip agent assignment (single session).

**Intra-domain parallel:** ≥4 independent tasks in 1 domain → multiple same-type agents (F-full only). Shared barrel files → merge into single agent.

**2d. Tasks:** ∀ task: description, files, agent, dependencies, parallel-safe (Y/N).
Order: types → backend → frontend → tests → docs → config.

**2e. Slice Selection (multi-slice only):** ≥2 slices → AskUserQuestion (multiSelect): 1 option/slice `V{N}: {desc} ({files}, {agents})`.
Default: next unimplemented slice. Respect deps. Re-run `/plan` for remaining.

**2f. Present Plan:** AskUserQuestion: τ, slices, files, agents, tasks with `[parallel-safe: Y/N]`.
Options: **Approve** | **Modify** | **Cancel**
**Approve → immediately continue to Step 3 (¬stop).**

## Step 3 — Ref Patterns

Find similar existing feature → read 1–2 files for conventions. Store paths → note in π for Step 4 agent context injection.

## Step 4 — Micro-Tasks (Tier F only)

Tier S → skip → Step 5. Read [references/micro-tasks.md](references/micro-tasks.md) for complete process.

**Summary:** Detect σ format (Breadboard+Slices ∨ Success Criteria) → generate micro-tasks with verify commands → detect parallelization → scale task count → consistency check (σ↔tasks bidirectional) → write to π.

Key outputs: micro-tasks with fields below, `[P]` parallel markers, RED-GATE sentinels per slice.

See [references/micro-task-example.mdx](references/micro-task-example.mdx) for a worked example.

### Micro-Task Fields

| Field | Description |
|-------|-------------|
| Description | Imperative, specific |
| File path | Target file |
| Code snippet | Expected shape skeleton |
| Verify command | Bash confirmation |
| Expected output | Success criteria |
| Time estimate | 2–5 min (up to 8–10 for atomic ops) |
| `[P]` marker | Parallel-safe |
| Agent | Owner |
| Spec trace | SC-N ∨ U1→N1→S1 |
| Slice | V1, V2, ... |
| Phase | RED ∨ GREEN ∨ REFACTOR ∨ RED-GATE |
| Difficulty | 1–5 |

## Step 5 — Write Plan Artifact

Write to `artifacts/plans/{N}-{slug}-plan.mdx`. Create `artifacts/plans/` dir if needed.

Use [references/plan-template.mdx](references/plan-template.mdx). See [references/micro-task-example.mdx](references/micro-task-example.mdx) for task formatting.

```markdown
---
title: "Plan: {title}"
issue: {N}
spec: artifacts/specs/{N}-{slug}-spec.mdx
complexity: {score}/10
tier: {τ}
generated: {ISO}
---
```

Include:
- Summary (1–2 sentences)
- Architecture diagrams (mermaid, see below)
- Bootstrap Context (from analysis if ∃, omit if ¬∃)
- Agents table (agent, task count, files)
- Consistency Report (covered/total, uncovered, untraced, exemptions)
- Micro-Tasks (grouped by slice/criteria, with RED-GATE sentinels)

### Mermaid Diagrams

`## Architecture` section must include:

1. **Data flow diagram** (`flowchart TD`) — show the full pipeline: config files → loader functions → data structures → composition → runtime injection. Group nodes into subgraphs by file. Highlight key paths (override, hot-reload) with distinct styles.

2. **File × Function map** (`flowchart LR`) — show which functions/classes live in which files and how they call each other. Group by source file. Show test files as consumers.

Diagrams go AFTER Summary and BEFORE Bootstrap Context. They answer "how does the implementation flow across files" — the plan's equivalent of the spec's data model diagrams.

## Step 6 — Approve + Commit

AskUserQuestion: complexity, τ, task count, agents, consistency, slices.
Options: **Approve** | **Modify** | **Return to spec**

On Approve → commit artifact: `git add artifacts/plans/{N}-{slug}-plan.mdx` + commit per CLAUDE.md Rule 5.

## Edge Cases

Read [references/edge-cases.md](references/edge-cases.md).

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬create issue without user approval
3. Always present plan (2f) before writing artifact
4. Show full task list (¬truncate) when |tasks| > 30

$ARGUMENTS
