# Dev-Core Pipeline Chain Contract

> **⚠ Reference: not loaded by skills at runtime.** This file exists as a human-readable contract for contributors. Each pipeline skill declares its own Chain Position + Task Integration + Exit inline (redundancy-with-locality). Do not `@include` this file from SKILL.md.

## Purpose

Defines how the 13 dev-core pipeline skills participate in the `/dev` orchestration and how chaining, task lifecycle, and exit behavior work across them.

> **Issue triage is not a dev-core step.** `roxabi-issues:issue-triage` runs *before* `/dev`, in a separate plugin (relocated dev-core → roxabi-issues, 2026-06-09). The dev-core pipeline itself starts at `recheck`.

## Pipeline

```
issue-triage (external, roxabi-issues) → recheck → frame ⏸?→ analyze ⏸→ spec ⏸→ plan ⏸→ implement → pr
            → ci-watch → validate → code-review → {fix ↺ review | merge → cleanup}
```

> `⏸` = the pipeline stops the turn awaiting free-form approval (chat Executive Summary; ¬AskUserQuestion).
> - `frame ⏸?`: stop only when ¬high_conf; **high_conf auto-approves** same turn (seed complete, premise ok, tier not contested).
> - `analyze ⏸→ spec`: always prints Executive Summary and waits. τ ∈ {S, F-lite} skip analyze entirely.
> - `spec ⏸→ plan`: chat Executive Summary (same doctrine; disk `status ≠ draft`).
> - `plan ⏸→ implement`: plan Executive Summary → free-form approve → seed+commit; then `/dev` Step 8b **compact pause** before `/implement`. τ=S skips plan entirely.

### Parallel meta: `/ship` (code already ready)

```
commit → pr → code-review → {fix ↺ review}×≤2 → label reviewed → ci-watch → cleanup?
```

`/ship` is a **second orchestrator** (not a step inside `/dev`). Use when the feature branch already has the work and you only want the gate path. Differences vs `/dev` Verify:

| | `/dev` Verify | `/ship` |
|---|---|---|
| Order | pr → **ci-watch** → validate → **review** → fix | commit → pr → **review** → fix → **reviewed + ci-watch** |
| validate | yes | no |
| commit | via implement | first-class step |
| `reviewed` label | via code-review Phase 8 / fix Phase 7 | owned by ship after final APPROVED (strips premature label after `/fix` before re-review) |

¬add `/ship` steps to `/dev` STEPS list — they remain separate entry points.

## Ownership model

| Concern | Owner |
|---|---|
| dev-pipeline task lifecycle (seed, in_progress, completed, cancelled) | `/dev` |
| Step transitions (what runs next) | `/dev` Step 5 STEPS list + Step 7 invocation map |
| Gate approval prompts (legacy / rare) | `/dev` Step 6 only where still needed (e.g. F-full architecture sketch pre-plan) |
| Approval-stop (frame, analyze, spec, plan) | the skill itself — chat Executive Summary (¬AQ); `/dev` Step 8.0 disk-asserts done-signal before complete |
| Compact pause (plan→implement, F-lite/F-full) | `/dev` Step 8b |
| Standalone invocation fallback | Each skill's Exit section |
| Sub-task creation (with `kind` ≠ `dev-pipeline`) | Individual skills (plan, code-review) |
| Loop handling (review ↔ fix) | Follow-up TaskCreate with `metadata.iteration` |

## Skill classes

| Class | Meaning | Skills | Exit behavior |
|---|---|---|---|
| **adv** | Continuous flow, no user gate | recheck, implement, pr, ci-watch, validate, cleanup | Return silently; `/dev` auto-advances |
| **adv + approval stop** | Dispatched like `adv`; chat Executive Summary + free-form approve (¬AskUserQuestion). Optional high-conf auto-approve (frame only). | frame, analyze, spec, plan | Print summary → **stop** unless high_conf auto-approve (frame). `/dev` Step 8.0: disk done-signal before complete. Walk **ignores `Σ_s` alone** for these steps. Resume = skill React (¬fresh Step 0). **plan:** after approve+seed, compact pause before `/implement`. |
| **gate** | (legacy / rare pre-gates only) | — | Prefer `adv + approval stop` for pipeline artifacts. `/dev` may still use structured prompts for F-full architecture sketch / issue create. |
| **verdict** | Branches based on outcome | code-review | APPROVED → merge → cleanup; CHANGES_REQUESTED → `/fix` |
| **loop** | Cycles back to predecessor (bounded) | fix | On success → TaskCreate follow-up review; max 2 iterations |
| **standalone** | Never auto-triggered by `/dev` | promote, adversarial, advisory | Runs only on explicit user invocation |

### Done-signals (disk) for approval-stop skills

| Step | Done-signal |
|------|-------------|
| frame | φ `status: approved` |
| analyze | α `status: approved` ∨ status key absent (legacy) |
| spec | σ ∃ ∧ `status ≠ draft` (missing status ≡ approved legacy) |
| plan | π ∃ ∧ `## Task IDs` with ≥1 `T\d+:` line (written only after free-form approve + seed) |

## Task lifecycle contract

### dev-pipeline task (kind: "dev-pipeline")

- **Created by:** `/dev` Step 2b at the start of a pipeline run
- **Updated by:** `/dev` only — Step 7 sets `in_progress` before invocation, Step 8 sets `completed` on success
  - **Exception (`adv + approval stop`):** a skill that ends its turn awaiting approval has not succeeded yet. `/dev` leaves the task `in_progress` and sets `completed` only after the disk done-signal (approve reaction or frame high_conf auto-approve). Applies to: `frame`, `analyze`, `spec`, `plan`.
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

### adv + approval-stop Exit (frame, analyze, spec, plan)

```markdown
## Exit

The Executive Summary is the gate output (not a closing recap). Frame may skip the stop when high_conf auto-approves.

- **While waiting for reaction:** turn ends after the summary. Task stays `in_progress`; `/dev` Step 8.0 disk-asserts done-signal → else ¬Σ_s, ¬completed.
- **Resume:** next user message → skill React only (¬fresh Step 0) unless re-* / regenerate.
- **Approved via `/dev`:** set done-signal on disk, commit (plan: seed + ## Task IDs), return silently. `/dev` re-reads disk → completes step → successor.
- **Approved standalone:** print one line with next-skill hint. Stop.
- **Revise / side-path (adversarial|advisory) loop:** re-print the summary after each edit; stop again. Fix/fold only if user asks.
- **Abort:** return → `/dev` marks task `cancelled` (draft / no Task IDs left on disk as appropriate).
```

**Frame high_conf exception:** when interview/premise gaps are zero, tier not contested, and no premise abort signal → auto-approve + commit same turn (short summary printed; no approval STOP).

**`/plan` exception — compact pause:** after approve+seed+commit, `/dev` Step 8b prints a compact-pause recommendation (`/compact` → `/implement`, where `/dev #N` ≡ `/implement #N`) and stops the turn. Rationale: planning context is dead weight for the build phase; tasks persist (task list + artifact `## Task IDs`) so `/implement` Step 1b re-attaches after the compact. Re-fire guard: the pause is keyed to *plan having just run*, so the post-compact `/dev #N` resume goes straight to `/implement`.

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
2. Add it to `/dev` Step 7 invocation map with its class (adv|adv + approval stop|gate|verdict|loop|standalone)
3. Add it to `/dev` Step 4 skip logic if conditionally skipped
4. Add it to `/dev` Tier Skip Matrix (S|F-lite|F-full columns)
5. Add the three canonical body sections to the skill's own SKILL.md: **Chain Position**, **Task Integration**, **Exit** (using the class-appropriate Exit pattern)
6. Update this reference file if the new skill introduces a new class

When adding a **meta-orchestrator** (like `/ship`):

1. New skill directory under `skills/<name>/` with SKILL.md + README.md
2. Document relation to `/dev` (when to use which) — do **not** force-insert into `/dev` STEPS unless the full lifecycle should change
3. Update this contract + plugin README skills table
4. Child skills keep their Exit “via `/dev`” paths; add “via `/ship`” only if behavior must differ (e.g. strip `reviewed` after fix)

## Cache synchronization

Edits to SKILL.md files must be propagated to the plugin cache by re-installing the plugin from the marketplace:

```bash
claude plugin install dev-core
```

This pulls the marketplace clone and repopulates the hash-keyed cache dir, ensuring all 13 pipeline skills land atomically.

## Related documents

- ADR: `docs/adr/00X-dev-core-chain-contract.md` — rationale for distributed declaration + /dev-owns-lifecycle
- `/dev` SKILL.md — orchestration state machine
- `/plan` SKILL.md — reference implementation of sub-task creation
- `/implement` SKILL.md — reference implementation of sub-task consumption
- [artifact-frontmatter.md](./artifact-frontmatter.md) — title hygiene + `type:`/`status:` required keys for every writer
