---
name: dev
argument-hint: '[#N | "idea" | --from <step> | --audit]'
description: Workflow orchestrator — single entry point for the full dev lifecycle. Triggers: "dev" | "start working on" | "work on issue" | "work on #" | "develop" | "pick up issue" | "tackle issue" | "let's work on".
version: 0.3.1
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Dev

## Success

I := ∀ steps ∈ pipeline → done ∨ skipped (per tier) ∧ issue closed
V := TaskList: all `status: completed` ∨ Σ.step == true ∨ should_skip(step)

Let:
  N    := issue number
  slug := kebab-case title slug
  τ    := tier (S | F-lite | F-full)
  Σ    := state map (step → bool | null), persisted via artifacts
  Σ_s  := session state map (step → bool), in-memory only, lost on restart
  S*   := next step to execute
  φ    := frame artifact
  gate := {frame, spec, plan}
  adv  := {analyze, implement, pr, ci-watch, validate, review, fix, cleanup}
  ψ_r(P) ⟺ P.comments ∃ body: "## Code Review"
  ψ_f(P) ⟺ P.comments ∃ body: "## Review Fixes Applied"
  stale  := scan-state.sh `stale=true|false` — worktree ∃ ∨ local/remote branch matching N ∃ (anchored on N, see scan-state.sh)
  bar   := output must read as hand-authored by a dev-core maintainer — match surrounding idiom, naming, comment density; calibrate against `plugins/dev-core/`; QG (format/lint/typecheck/test) = mechanical floor, ¬the bar

Single entry point: scan artifacts → detect state → show progress → delegate to step skill → loop.
¬rewrite step skill logic. ¬auto-advance phases. Present choice at each gate and wait for user reply.

## Entry

```
/dev #42             → resume/start from issue number
/dev "dark mode"     → find or create issue, then start
/dev #42 --from spec → jump to specific step (warn if deps missing)
/dev #42 --audit     → enable reasoning checkpoint before critical steps
/dev --cleanup-context → audit & clean CLAUDE.md, skills, memory (delegates to /cleanup-context)
```

## Step 0 — Parse Input

`--cleanup-context` ⇒ ∃ other flags → warn "Other flags ignored." Delegate: `skill: "cleanup-context"`. **Stop.**

`#N` ⇒ fetch:
```bash
gh issue view N --json number,title,labels,state
```
¬∃ → present choice **Create issue** | **Proceed without issue** (frame-only).

Free text ⇒ slug from text:
```bash
gh issue list --search "{text}" --json number,title,state --jq '.[:3]'
```
∃ match → present choice **Use #{N}: {title}** | **Create new** | **Proceed without issue**.

`--from <step>` ⇒ record override. Warn if prerequisite artifacts ¬∃:

| Step | Required artifacts |
|------|-------------------|
| recheck | issue — no on-disk prereq; always runs from session state |
| frame | issue |
| analyze | `artifacts/frames/{N}-{slug}-frame.md` or `artifacts/frames/{slug}-frame.md` (approved) |
| spec | `artifacts/frames/{slug}-frame.md` or `artifacts/analyses/{N}-{slug}-analysis.md` |
| plan | `artifacts/specs/{N}-{slug}-spec.md` |
| implement | `artifacts/plans/{N}-{slug}-plan.md` (or spec for S-tier) |
| pr | worktree with code changes |
| validate | PR ∃ |
| review | PR ∃ |
| fix | review findings (PR comment with "## Code Review") |

## Step 1 — Scan State (parallel, <3s)

```bash
bash ${CLAUDE_SKILL_DIR}/scan-state.sh {N} {slug}
```

φ ∃ → read frontmatter → extract `status`, `tier`.

Σ = {
  recheck:   null,       # Σ_s only — runs every session, no on-disk state
  frame:     φ ∃ ∧ φ.status == 'approved',
  analyze:   analysis artifact ∃,
  spec:      spec artifact ∃,
  plan:      plan artifact ∃,
  implement: worktree ∃ (path: `.claude/worktrees/{N}-*` ∨ legacy `../${REPO}-{N}`) ∧ git diff --name-only origin/${BASE}..HEAD | grep -v '^artifacts/' is non-empty,
  pr:        PR ∃,
  ci-watch:  null,       # Σ_s only
  validate:  null,       # Σ_s only
  review:    PR ∃ ∧ (PR.reviewDecision ∈ ('APPROVED','CHANGES_REQUESTED') ∨ ψ_r(PR)),
  fix:       PR ∃ ∧ ψ_f(PR),
  promote:   skipped,  # standalone staging→main, ¬feature cycle
  cleanup:   ¬stale,
}

Σ_s = {} initially. Populated in Step 8 after each skill completes. Lost on restart.
Σ[step] == null → relies on Σ_s for within-session advancement.

τ = φ.tier || issue_size_label_to_tier(issue.labels) || null

## Step 2 — Determine Tier

τ ∃ → skip.
¬τ → present choice **S** (≤3 files, no arch) | **F-lite** (clear scope, 1 domain) | **F-full** (complex, multi-domain).

## Step 2b — Seed Pipeline Tasks

Claude Code task list drives in-session progress for the dev pipeline. Treat it as authoritative for within-session state — artifacts remain authoritative across sessions.

**2b.1 Check existing:** `TaskList` → filter where `metadata.issue == N` ∧ `metadata.kind == 'dev-pipeline'`. ∃ matches → skip seeding (tasks already exist from a prior `/dev` invocation in this session). Cache {step → task.id} map from the matches. Goto 2b.4.

**2b.2 Build active sequence:** Apply Step 4 skip logic to τ + Σ. Skipped steps are **not** created — keeps the timeline clean.

Ordered step list:
```
recheck → frame → analyze → spec → plan → implement → pr →
ci-watch → validate → review → fix → promote → cleanup
```

**2b.3 Create tasks:** ∀ step ∈ active_list:

```
TaskCreate(
  subject: "{step} — #{N} {title}",
  description: "{one-line step purpose from dev-process.md}",
  activeForm: "{present-continuous of step} #{N}",
  metadata: {
    kind: "dev-pipeline",
    issue: N,
    step: "{step}",
    phase: "Frame|Shape|Build|Verify|Ship",
    tier: τ,
  },
)
```

Wire dependencies sequentially — ∀ i > 0: `TaskUpdate(task[i].id, addBlockedBy: [task[i-1].id])`. Cache {step → task.id} map in-memory.

**2b.4 Mark done from Σ:** ∀ step where Σ[step] == true ∨ Σ_s[step] == true → `TaskUpdate(task.id, status: "completed")`. Artifacts on disk mean the step is done even on first `/dev` entry of the session.

## Step 3 — Progress Display

```
## {title} (#{N})  [{τ}]

  Frame    {bar}  {step statuses}
  Shape    {bar}  {step statuses}
  Build    {bar}  {step statuses}
  Verify   {bar}  {step statuses}
  Ship     {bar}  {step statuses}

→ Next: {S*} — {one-line description}
```

Bar: `██`=done/skipped, `░░`=pending. Phases: Frame:{recheck,frame} | Shape:{analyze,spec} | Build:{plan,implement,pr} | Verify:{ci-watch,validate,review,fix} | Ship:{promote,cleanup}

Status: `✓ {name}` (done) | `skipped` | `pending` | `→ next`.

## Step 4 — Skip Logic

```
should_skip(step, τ, Σ):
  recheck                                 → false (never skipped — explicit decision per frame #181)
  frame    ∧ τ == S                       → skip
  analyze  ∧ τ ∈ {S, F-lite}             → skip (frame sufficient)
  spec     ∧ τ == S                       → skip
  plan     ∧ τ == S                       → skip
  ci-watch ∧ ¬PR ∃                         → skip
  fix      ∧ (Σ.fix ∨ Σ_s.fix)            → skip (fixes already applied)
  promote                                  → skip (/promote is standalone staging→main; ¬auto-triggered by /dev)
  cleanup  ∧ ¬stale                       → skip
  default                                 → false
```

`--from <step>` ⇒ force-mark all prior steps skipped (warn once).

## Step 5 — Walk Steps + Find Next

```
STEPS = [
  (Frame,  recheck,   recheck),
  (Frame,  frame,     frame),
  (Shape,  analyze,   analyze),
  (Shape,  spec,      spec),
  (Build,  plan,      plan),
  (Build,  implement, implement),
  (Build,  pr,        pr),
  (Verify, ci-watch,  ci-watch),
  (Verify, validate,  validate),
  (Verify, review,    review),
  (Verify, fix,       fix),
  (Ship,   promote,   promote),
  (Ship,   cleanup,   cleanup),
]
```

Walk: Σ[step] == true ∨ Σ_s[step] == true ∨ should_skip(step) ⇒ done/skipped, continue. First non-done non-skipped ⇒ S*.

∀ steps done ⇒ completion banner, exit.

## Step 6 — Gate Check

| Gate trigger | Behavior |
|-------------|----------|
| S* == frame (¬Σ.frame) | Show φ if ∃ draft, ask approval |
| S* == spec (Σ.frame ∧ ¬Σ.spec) | Gate after spec runs |
| S* == plan (Σ.spec ∧ ¬Σ.plan) ∧ τ == F-full | Architecture sketch (see block below) → user confirm → THEN invoke /plan. ¬fires for τ ∈ {S, F-lite}. |
| S* == plan (Σ.spec ∧ ¬Σ.plan) ∧ τ ∈ {S, F-lite} | Gate after plan runs |
| S* == review | Post-review gate handled inside /code-review |

Gate fires → Step 7 skips its own prompt (gate IS confirmation). ¬double-prompt.

### Architecture Sketch Gate (F-full only, pre-plan)

**Trigger:** S* == plan ∧ τ == F-full ∧ ¬Σ.plan — fires BEFORE invoking `/plan`. ¬fires for τ ∈ {S, F-lite}.

Present a concise architecture sketch covering four elements:
- **(a) Component boundaries** — enumerate modules/packages/services involved and their single responsibility
- **(b) Data flow per layer** — how data moves from entry point through each layer to persistence/output
- **(c) State ownership** — which component owns each piece of mutable state; ¬shared-mutable across boundaries
- **(d) Integration points** — external systems, APIs, events, or side-effects touched by this change

→ present choice **Confirm sketch → proceed to /plan** | **Revise sketch** (max 2 rounds) | **Abort**

User confirm received → invoke `skill: "plan"` (Step 7). This gate runs earlier than (and is distinct from) the post-plan compact pause (Step 8b).

## Step 6b — Reasoning Audit (optional)

**Trigger:** `--audit` ∨ S* ∈ `workflow.reasoning_audit` (stack.yml). critical := {spec, plan, implement}.

audit ∧ S* ∈ critical → reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md). Gate ∃ for S* → audit **replaces** it (¬double-prompt). ¬pass `--audit` to child skills.
**Exception — F-full architecture sketch (R7a):** `--audit` NEVER replaces the architecture-sketch gate; sketch always fires for τ == F-full ∧ S* == plan, even when reasoning audit runs (two separate prompts: sketch → confirm, then audit → proceed).
→ present choice **Proceed** | **Adjust approach** (max 3 rounds) | **Abort** (→ skipped, Step 5)

¬audit ∨ S* ∉ critical → skip (Step 6 gate still applies).

## Step 7 — Execute Step

**Worktree bootstrap (silent pre-step):** `worktree` == false ∧ S* ∈ {frame, analyze, spec, plan, implement} → invoke `skill: "setup-worktree", args: "{N:+--issue $N }--slug {slug}"` first. After return, re-scan `worktree`. Still false → present choice: **Retry** | **Abort**.

**Artifact sync (post-bootstrap):** If S* ∈ {frame, analyze, spec, plan} and the repo principal has artifacts that the worktree lacks (e.g. from a prior standalone run) → `rsync -a ../../../artifacts/ ./artifacts/` (idempotent, preserves future commits).

**Before invocation:** `TaskUpdate(task_id_map[S*], status: "in_progress")`. ¬∃ id → `TaskCreate` on-the-fly (drift safety net: a step not seeded in 2b that became active later).

**Invocation rules — CRITICAL for continuous flow:**

- **gate skills** (frame, spec, plan): Step 6 already presented decision → invoke skill immediately. ¬double-prompt. ¬write transition message.
- **adv skills** (all others): invoke skill immediately. ¬write "Running /X…" preamble. ¬ask permission. ¬summarize prior step.

**¬ask** "Ready to proceed to /X?" — the task list IS the commitment.
**¬ask** "Shall I continue?" — Step 8 re-scan IS the continuation.
**¬summarize** "Just completed /X, moving to /Y" — the next skill's output IS the signal.
**¬announce** "Moving to the next step" — silent transition only.

**Exception:** user may type "stop"/"skip to X" before skill completes.

**Follow-up tasks:** child skill surfaces new work (e.g. `/code-review` emits findings that require a fix iteration, `/ci-watch` detects flakes needing re-run) → `TaskCreate` a follow-up task with metadata `{ kind: "dev-pipeline", issue: N, step: "{step}", follow_up: true }` and `addBlockedBy: [task_id_map[S*]]`.

**Skill invocation map:**

| Step | Class | Skill invocation | On success → |
|------|-------|------------------|--------------|
| recheck | adv | `skill: "recheck", args: "--from-dev #N"` | frame |
| frame | gate | `skill: "frame", args: "{N:+--issue $N}"` | analyze (F-full) ∨ spec (F-lite) |
| analyze | adv | `skill: "analyze", args: "{N:+--issue $N}"` | spec |
| spec | gate | `skill: "spec", args: "{N:+--issue $N}"` | plan |
| plan | gate | `skill: "plan", args: "{N:+--issue $N}"` | implement — via Step 8b compact pause (F-lite/F-full; ¬auto-chain) |
| implement | adv | `skill: "implement", args: "{N:+--issue $N}"` | pr |
| pr | adv | `skill: "pr"` (auto-detects branch + issue) | ci-watch |
| ci-watch | adv | `skill: "ci-watch", args: "--pr {PR#}"` | validate |
| validate | adv | `skill: "validate"` | code-review |
| review | verdict | `skill: "code-review"` | APPROVED → merge → cleanup \| CHANGES_REQUESTED → fix |
| fix | loop | `skill: "fix", args: "#{PR_NUMBER}"` | code-review (max 2 iters, then Abort) |
| promote | — | `skill: "promote"` (standalone — never auto-triggered) | — |
| cleanup | adv | `skill: "cleanup", args: "--scope #N"` | pipeline complete |

**Skip to X** ⇒ → present choice **Proceed anyway** | **Cancel**. Missing artifacts → warn first. Proceed ⇒ mark prior steps skipped, S* = X.

**Stop** ⇒ "Stopped at {S*}. Run `/dev #N` to resume."

## Step 8 — Post-skill Re-scan

Skill returns → **IMMEDIATELY in the same turn, silently:**

1. `TaskUpdate(task_id_map[S*], status: "completed")`
2. `Σ_s[step] = true`
3. Goto Step 1 (re-scan Σ)
4. **Compact pause** (Step 8b) — completed step == plan ∧ τ ∈ {F-lite, F-full} ∧ new S* == implement → present pause, **STOP this turn** (¬Step 7).
5. Execute Step 7 for new S*

**¬write** "Step X complete" message between skill return and re-scan.
**¬write** "Moving to Y" message between re-scan and Step 7.
**¬ask** anything. The next skill's first output IS your next message.
**¬summarize** what just happened. The task list reflects state.

Skill fails/aborts → leave task `in_progress` → present choice: **Retry** | **Skip** | **Abort**.
Σ_s ensures within-session advancement for artifact-less steps (validate, review, fix).
Session restart → Σ_s = ∅ → artifact-less steps re-run. 2b.1 will find the existing tasks (status possibly `completed` from last run) and skip re-seeding.
gate → re-scan detects updated artifact → Step 6 gate → Step 7 immediately (¬second prompt). **Exception:** completed gate == plan ∧ τ ∈ {F-lite, F-full} → Step 8b compact pause (¬Step 7 this turn).
adv → re-scan → Step 7 immediately.

## Step 8b — Compact Pause (plan→implement, F-lite/F-full)

**Trigger:** in Step 8, the step that just completed == `plan` ∧ τ ∈ {F-lite, F-full} ∧ new S* == `implement`.
τ=S never reaches here — `plan` is skipped, so the pipeline goes straight to `implement` with no pause.

**Why:** `/plan` consumed heavy context (spec read, scope glob/grep, micro-task generation, forge-chart sidecars). `/implement` spawns fresh agents whose context is injected from the task list + plan artifact — the planning conversation is dead weight. Tasks persist (task list + plan artifact `## Task IDs`); `/implement` Step 1b re-attaches after a context reset. `/compact` = soft restart → safe.

**Behavior:** do **NOT** auto-chain to `/implement`. Print the recommendation block below and **STOP this turn** (Claude cannot invoke `/compact` — it is user-typed):

```
✓ Plan approved — {n} tasks seeded + committed ({τ}).
  Tasks persist (task list + plan artifact ## Task IDs) → safe to compact.

  Recommended before building:
    1. /compact          clear planning context
    2. /dev #{N}         resume → re-attaches tasks → ≡ /implement #{N}

  Skip compact? → /implement --issue {N} directly.
```

**Re-fire guard:** the pause is keyed to *plan having just run this turn*, not to *implement being next*. On the resume turn (`/dev #{N}` after `/compact`), `/dev` did not execute `plan` (Σ.plan already true on disk) → Step 8b does not apply → Step 7 invokes `/implement` directly, no second prompt.

## Phases + Gate Summary

| Phase | Steps | Gate after |
|-------|-------|-----------|
| Frame | recheck → frame | frame approval (status: approved) |
| Shape | analyze → spec | spec approval |
| Build | plan → implement → pr | plan approval → compact pause (F-lite/F-full, Step 8b) before implement → pr |
| Verify | ci-watch → validate → review → fix | post-review: fix/merge/stop. Merge = feature→staging (via /code-review Phase 8). |
| Ship | promote → cleanup | promote always skipped. cleanup runs if worktree/branches stale. |

## Tier Skip Matrix

| Step | S | F-lite | F-full |
|------|---|--------|--------|
| recheck | run | run | run |
| frame | skip | run + gate | run + gate |
| analyze | skip | skip | run |
| spec | skip | run + gate | run + gate |
| plan | skip | run + gate | run + gate |
| implement | run | run | run |
| pr | run | run | run |
| ci-watch | cond | cond | cond |
| validate | run | run | run |
| review | run | run | run |
| fix | cond | cond | cond |
| promote | cond | cond | cond |
| cleanup | cond | cond | cond |

cond = applicable only (see skip logic).

## Completion

∀ steps done/skipped ⇒

```
## Done — {title} (#{N})

  Frame    ██████████  ✓
  Shape    ██████████  ✓ (analyze skipped)
  Build    ██████████  ✓
  Verify   ██████████  ✓
  Ship     ██████████  ✓

Issue #{N} closed. Worktree cleaned up.

Next: feature is merged to staging.
To promote to production → run `/promote`
```

## Edge Cases

- Session dies mid-step → `/dev #N` resumes. Re-scan detects partial state. Half-written artifact → step skill handles.
- `--from <step>` ∧ missing deps → warn + → present choice **Proceed** | **Cancel**.
- Issue ¬∃ ∧ free text → frame-only mode. φ approved → present choice **Create GitHub issue** | **Continue without**.
- S* == validate → Σ.validate always null. Σ_s advances within session. New session → re-runs.
- Multiple PRs for same issue → list, → present choice select which.

$ARGUMENTS
