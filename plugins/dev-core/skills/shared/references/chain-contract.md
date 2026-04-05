# Dev-Core Pipeline Chain Contract

> **⚠ Reference: not loaded by skills at runtime.** This file exists as a human-readable contract for contributors. Each pipeline skill declares its own Chain Position + Task Integration + Exit inline (redundancy-with-locality). Do not `@include` this file from SKILL.md.

## Purpose

Defines how the 13 dev-core pipeline skills participate in the `/dev` orchestration and how chaining, task lifecycle, and exit behavior work across them.

## Pipeline

```
issue-triage → frame → analyze → spec → plan → implement → pr
            → ci-watch → validate → code-review → {fix ↺ review | merge → cleanup}
```

## Ownership model

| Concern | Owner |
|---|---|
| dev-pipeline task lifecycle (seed, in_progress, completed, cancelled) | `/dev` |
| Step transitions (what runs next) | `/dev` Step 5 STEPS list + Step 7 invocation map |
| Gate approval prompts (frame, spec, plan) | `/dev` Step 6 + the skill itself |
| Standalone invocation fallback | Each skill's Exit section |
| Sub-task creation (with `kind` ≠ `dev-pipeline`) | Individual skills (plan, code-review) |
| Loop handling (review ↔ fix) | Follow-up TaskCreate with `metadata.iteration` |

## Skill classes

| Class | Meaning | Skills | Exit behavior |
|---|---|---|---|
| **adv** | Continuous flow, no user gate | issue-triage, analyze, implement, pr, ci-watch, validate, cleanup | Return silently; `/dev` auto-advances |
| **gate** | User approval of artifact required | frame, spec, plan | Present artifact → on approve, return silently; `/dev` auto-chains to successor |
| **verdict** | Branches based on outcome | code-review | APPROVED → merge → cleanup; CHANGES_REQUESTED → `/fix` |
| **loop** | Cycles back to predecessor (bounded) | fix | On success → TaskCreate follow-up review; max 2 iterations |
| **standalone** | Never auto-triggered by `/dev` | promote | Runs only on explicit user invocation |

## Task lifecycle contract

### dev-pipeline task (kind: "dev-pipeline")

- **Created by:** `/dev` Step 2b at the start of a pipeline run
- **Updated by:** `/dev` only — Step 7 sets `in_progress` before invocation, Step 8 sets `completed` on success
- **NOT updated by:** individual pipeline skills (they are passive participants)
- **Metadata:** `{ kind: "dev-pipeline", issue: N, step: "...", phase: "Frame|Shape|Build|Verify|Ship", tier: τ }`
- **Dependencies:** wired sequentially via `blockedBy` during seeding (graph is a DAG, no cycles)

### Sub-tasks (kind: "plan-task", "review-finding", etc.)

Skills that break their work into trackable sub-units create their own tasks with a distinct `kind`:

| Skill | Sub-task kind | Purpose |
|---|---|---|
| `/plan` | `plan-task` | One per micro-task in the plan; IDs persisted in artifact `## Task IDs` section |
| `/code-review` | `review-finding` (if used) | One per finding, ephemeral |

Sub-tasks are independent of dev-pipeline lifecycle but may `blockedBy` their parent dev-pipeline task for observability.

### Loop handling (review ↔ fix)

The chain is not cyclic in the `blockedBy` graph — it is a DAG with **follow-up task creation**:

```
review-iter-1 (dev-pipeline)
  └─ CHANGES_REQUESTED → TaskCreate fix-iter-1 {follow_up: true, iteration: 1, blockedBy: [review-iter-1]}

fix-iter-1 (dev-pipeline)
  └─ success → TaskCreate review-iter-2 {follow_up: true, iteration: 2, blockedBy: [fix-iter-1]}

review-iter-2 (dev-pipeline)
  └─ CHANGES_REQUESTED → TaskCreate fix-iter-2 {iteration: 2}
     OR APPROVED → merge → cleanup

fix-iter-2 (dev-pipeline)
  └─ iteration == 2 → Phase 8 must recommend Merge as-is or Stop, not Fix
  └─ user picks Fix anyway → /dev presents Abort
```

**Loop cap: 2 fix↔review iterations.**

## Exit patterns (per class)

### adv-class Exit

```markdown
## Exit

- **Success via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce successor. `/dev` re-scans and advances.
- **Success standalone:** print one line with next-skill hint. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.
```

### gate-class Exit

```markdown
## Exit

- **Approved via `/dev`:** write artifact with `status: approved`, commit, return silently. ¬ask "proceed to /X?". `/dev` re-scans and auto-chains to successor in the same turn.
- **Approved standalone:** print one line with next-skill hint. Stop.
- **Modify requested:** loop in-skill, re-present.
- **Rejected/aborted:** return → `/dev` marks task `cancelled`.
```

### verdict-class Exit (code-review)

```markdown
## Exit

- **APPROVED via `/dev`:** merge → return. `/dev` advances to `/cleanup`.
- **CHANGES_REQUESTED via `/dev`:** TaskCreate follow-up fix task → return silently. `/dev` picks up the new task.
- **Stop:** return → `/dev` presents Abort | Resume.
- **Loop cap:** max 2 fix↔review iterations (metadata.iteration).
```

### loop-class Exit (fix)

```markdown
## Exit

- **Success via `/dev`:** fixes applied → TaskCreate follow-up review task → return silently.
- **Success standalone:** print summary + `Next: /code-review`. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.
- **Loop cap:** iteration ≥ 2 on entry → refuse, return message, `/dev` presents Abort.
```

### standalone-class Exit (promote)

```markdown
## Exit

- **Success standalone:** print result. Stop.
- **Failure:** return error. No `/dev` recovery path.
```

## Suppression imperatives

These imperatives exist in `/dev` Step 7/8 **and** in each skill's Exit section. Redundancy is intentional — the model reads them at different moments (orchestration vs skill execution).

- ¬ask "Ready to proceed to /X?"
- ¬ask "Shall I continue?"
- ¬summarize "Just completed /X, moving to /Y"
- ¬announce "Moving to the next step"
- The task list IS the commitment
- Step 8 re-scan IS the continuation
- The next skill's first output IS the next message

## Adding a new pipeline skill

When adding a new skill to the dev-core pipeline:

1. Add it to `/dev` Step 5 STEPS list at the appropriate position
2. Add it to `/dev` Step 7 invocation map with its class (adv|gate|verdict|loop|standalone)
3. Add it to `/dev` Step 4 skip logic if conditionally skipped
4. Add it to `/dev` Tier Skip Matrix (S|F-lite|F-full columns)
5. Add the three canonical body sections to the skill's own SKILL.md: **Chain Position**, **Task Integration**, **Exit** (using the class-appropriate Exit pattern)
6. Update this reference file if the new skill introduces a new class

## Cache synchronization

Edits to SKILL.md files must be propagated to the plugin cache:

```bash
cd ~/projects/roxabi-plugins
./sync-plugins.sh --local
```

The sync script has rollback-on-failure (as of the chain-contract refactor) to prevent partial-sync inconsistency across the 13 pipeline skills.

## Related documents

- ADR: `docs/adr/00X-dev-core-chain-contract.md` — rationale for distributed declaration + /dev-owns-lifecycle
- `/dev` SKILL.md — orchestration state machine
- `/plan` SKILL.md — reference implementation of sub-task creation
- `/implement` SKILL.md — reference implementation of sub-task consumption
