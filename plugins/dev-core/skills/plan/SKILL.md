---
name: plan
argument-hint: '[--issue <N> | --spec <path> | --audit]'
description: Implementation plan — tasks, agents, file groups, dependencies. Triggers: "plan" | "plan this" | "implementation plan" | "break it down" | "plan this feature" | "how should we build this" | "make a plan" | "create a plan" | "break this down into tasks" | "task breakdown".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Plan

## Success

I := π written ∧ ## Task IDs section ∃
V := `ls artifacts/plans/{N}-*.mdx` ∧ `grep "## Task IDs" artifacts/plans/{N}-*.mdx`

Let:
  σ := spec artifact
  π := plan artifact at `artifacts/plans/{issue}-{slug}.mdx`
  τ := tier ∈ {S, F-lite, F-full}

Spec → micro-tasks → agent assignments → plan artifact.

**Flow: single continuous pipeline. ¬stop between steps. Decision response → immediately execute next step. Stop only on: Cancel/Abort or Step 6 completion.**

```
/plan --issue 42         Generate plan from spec for issue #42
/plan --spec path        Generate plan from explicit spec path
/plan --issue 42 --audit Show reasoning checkpoint before planning
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | locate-spec | ✓ | σ ∃ | — |
| 2 | plan | ✓ | τ + agents defined | — |
| 3 | refs | — | ref paths noted | — |
| 4 | micro-tasks | — | tasks ∃ in π | Tier F only |
| 5 | write | ✓ | π ∃ | — |
| 6 | approve | ✓ | `git log` shows commit | gate |

## Step 1 — Locate Spec

`--issue N` → `ls artifacts/specs/N-*.mdx` → read full → extract title, criteria, files.
`--spec <path>` → read directly.
¬found → suggest `/spec` or `/dev`. **Stop.**

### Pre-flight: Ambiguity Check

Grep `\[NEEDS CLARIFICATION` in σ (count).
count > 0 → → DP(A) **Resolve now** | **Return to spec** | **Proceed anyway**

## Step 2 — Plan

Read `docs/processes/dev-process.mdx` + σ.

### Step 2a-pre — Reasoning Audit (optional)

`--audit` → after reading σ, present reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md) (plan guidance).
→ → DP(A) **Proceed** | **Adjust approach** | **Abort**
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
τ=S → skip agent assignment (single session).

Intra-domain parallel: ≥4 independent tasks in 1 domain → multiple same-type agents (F-full only). Shared barrel files → merge into single agent.

**2d. Tasks:** ∀ task: description, files, agent, dependencies, parallel-safe (Y/N).
Order: types → backend → frontend → tests → docs → config.

**2e. Slice Selection (multi-slice only):** ≥2 slices → → DP(C) 1 option/slice `V{N}: {desc} ({files}, {agents})`.
Default: next unimplemented slice. Respect deps. Re-run `/plan` for remaining.

**2f. Present Plan:** → DP(A) τ, slices, files, agents, tasks with `[parallel-safe: Y/N]`.
Options: **Approve** | **Modify** | **Cancel**
**Approve → immediately continue to Step 3 (¬stop).**

## Step 3 — Ref Patterns

Find similar existing feature → read 1–2 files for conventions. Store paths → note in π for Step 4 agent context injection.

## Step 4 — Micro-Tasks (Tier F only)

τ=S → skip → Step 5. Read [references/micro-tasks.md](${CLAUDE_SKILL_DIR}/references/micro-tasks.md) for complete process.

**Summary:** Detect σ format (Breadboard+Slices ∨ Success Criteria) → generate micro-tasks with verify commands → detect parallelization → scale task count → consistency check (σ↔tasks bidirectional) → write to π.

Key outputs: micro-tasks with fields below, `[P]` parallel markers, RED-GATE sentinels per slice.

See [references/micro-task-example.mdx](${CLAUDE_SKILL_DIR}/references/micro-task-example.mdx) for a worked example.

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

Use [references/plan-template.mdx](${CLAUDE_SKILL_DIR}/references/plan-template.mdx). See [references/micro-task-example.mdx](${CLAUDE_SKILL_DIR}/references/micro-task-example.mdx) for task formatting.

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

`## Architecture` must include:
1. **Data flow** (`flowchart TD`) — full pipeline: config files → loader functions → data structures → composition → runtime injection. Group nodes into subgraphs by file. Highlight key paths with distinct styles.
2. **File × Function map** (`flowchart LR`) — functions/classes per file, call relationships. Group by source file. Show test files as consumers.

Diagrams go AFTER Summary, BEFORE Bootstrap Context.

## Step 6 — Approve + Commit

→ DP(A) complexity, τ, task count, agents, consistency, slices.
Options: **Approve** | **Modify** | **Return to spec**

On Approve → **immediately** continue to 6a (seed tasks), 6b (persist IDs), 6c (commit). ¬stop between substeps.

### Step 6a — Seed Claude Code Tasks

∀ micro-task in π:

```
TaskCreate(
  subject: "{task description}",
  description: "{files}\n\nVerify: {verify_command}\nExpected: {expected_output}\nRef: {pattern_file}\nSpec trace: {spec_trace}",
  activeForm: "{present-continuous form}",
  metadata: {
    kind: "plan-task",
    issue: N,
    plan: "{path to π}",
    slice: "V{n}",
    phase: "RED|GREEN|REFACTOR|RED-GATE",
    agent: "{agent name}",
    spec_trace: "{SC-N or U1→N1→S1}",
    difficulty: {1-5},
    parallel_safe: {true|false},
  },
)
```

Cache returned id in {task# → task.id} map.

**Dependencies:** ∀ micro-task: `TaskUpdate(id, addBlockedBy: [deps...])` where deps come from:
1. Explicit `dependencies` field in the micro-task definition → map task numbers to task ids.
2. Phase order within a slice: GREEN tasks blocked by their slice's RED tasks; REFACTOR blocked by GREEN; RED-GATE sentinels blocked by all RED in the slice.

τ=S → still seed tasks (3–6 is typical) — gives visibility even in single-session flow. Skip phase-based dependency wiring when π has no slice structure.

### Step 6b — Persist Task IDs in Artifact

Append a `## Task IDs` section to π before committing:

```markdown
## Task IDs

<!-- Generated by /plan. Used by /implement to resume tasks on session restart. -->
- T1: {task_id} — {subject}
- T2: {task_id} — {subject}
...
```

This lets `/implement` re-attach to tasks after a session restart (TaskList would return empty for new sessions).

### Step 6c — Commit

`git add artifacts/plans/{N}-{slug}-plan.mdx` + commit per CLAUDE.md Rule 5.

## Edge Cases

Read [references/edge-cases.md](${CLAUDE_SKILL_DIR}/references/edge-cases.md).

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬create issue without user approval
3. Always present plan (2f) before writing artifact
4. Show full task list (¬truncate) when |tasks| > 30

## Chain Position

- **Phase:** Build
- **Predecessor:** `/spec` (artifact: `artifacts/specs/{N}-{slug}-spec.mdx`)
- **Successor:** `/implement` (auto-chain after approval)
- **Class:** gate (user approval of plan artifact required) → adv (auto-chain to `/implement`)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: plan-tasks (one per micro-task, `kind: "plan-task"`) via Step 6a, IDs persisted in artifact's `## Task IDs` section (Step 6b)

## Exit

- **Approved via `/dev`:** run Steps 6a/6b/6c (seed tasks, persist IDs, commit) → return silently. ¬ask "proceed to /implement?". `/dev` re-scans and auto-chains to `/implement` **in the same turn** (no second prompt).
- **Approved standalone:** print one line: `Approved. Next: /implement --issue N`. Stop.
- **Modify requested:** loop in-skill, re-present.
- **Rejected/aborted:** return → `/dev` marks task `cancelled`.

$ARGUMENTS
