---
name: dev
argument-hint: '[#N | "idea" | --from <step> | --audit]'
description: Workflow orchestrator — single entry point for the full dev lifecycle. Triggers: "dev" | "start working on" | "work on issue" | "work on #" | "develop" | "pick up issue" | "tackle issue" | "let's work on".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Dev

Let:
  N    := issue number
  slug := kebab-case title slug
  τ    := tier (S | F-lite | F-full)
  Σ    := state map (step → bool | null), persisted via artifacts
  Σ_s  := session state map (step → bool), in-memory only, lost on restart
  S*   := next step to execute
  φ    := frame artifact
  gate := {frame, spec, plan}
  adv  := {triage, analyze, implement, pr, ci-watch, validate, review, fix, cleanup}
  ψ_r(P) ⟺ P.comments ∃ body: "## Code Review"
  ψ_f(P) ⟺ P.comments ∃ body: "## Review Fixes Applied"

Single entry point: scan artifacts → detect state → show progress → delegate to step skill → loop.
¬rewrite step skill logic. ¬auto-advance phases. Present decision at each gate via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A).

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
¬∃ → → DP(A) **Create issue** | **Proceed without issue** (frame-only).

Free text ⇒ slug from text:
```bash
gh issue list --search "{text}" --json number,title,state --jq '.[:3]'
```
∃ match → → DP(A) **Use #{N}: {title}** | **Create new** | **Proceed without issue**.

`--from <step>` ⇒ record override. Warn if prerequisite artifacts ¬∃:

| Step | Required artifacts |
|------|-------------------|
| frame | issue (triage) |
| analyze | `artifacts/frames/{N}-{slug}-frame.mdx` or `artifacts/frames/{slug}-frame.mdx` (approved) |
| spec | `artifacts/frames/{slug}-frame.mdx` or `artifacts/analyses/{N}-{slug}-analysis.mdx` |
| plan | `artifacts/specs/{N}-{slug}-spec.mdx` |
| implement | `artifacts/plans/{N}-{slug}-plan.mdx` (or spec for S-tier) |
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
  triage:    issue ∃,
  frame:     φ ∃ ∧ φ.status == 'approved',
  analyze:   analysis artifact ∃,
  spec:      spec artifact ∃,
  plan:      plan artifact ∃,
  implement: worktree ∃ (path: `.claude/worktrees/{N}-*` ∨ legacy `../${REPO}-{N}`) ∧ branch has commits beyond staging,
  pr:        PR ∃,
  ci-watch:  null,       # Σ_s only
  validate:  null,       # Σ_s only
  review:    PR ∃ ∧ (PR.reviewDecision ∈ ('APPROVED','CHANGES_REQUESTED') ∨ ψ_r(PR)),
  fix:       PR ∃ ∧ ψ_f(PR),
  promote:   skipped,  # standalone staging→main, ¬feature cycle
  cleanup:   ¬worktree ∃ ∧ ¬stale_branch ∃,
}

Σ_s = {} initially. Populated in Step 8 after each skill completes. Lost on restart.
Σ[step] == null → relies on Σ_s for within-session advancement.

τ = φ.tier || issue_size_label_to_tier(issue.labels) || null

## Step 2 — Determine Tier

τ ∃ → skip.
¬τ → → DP(A) **S** (≤3 files, no arch) | **F-lite** (clear scope, 1 domain) | **F-full** (complex, multi-domain).

## Step 2b — Seed Pipeline Tasks

Claude Code task list drives in-session progress for the dev pipeline. Treat it as authoritative for within-session state — artifacts remain authoritative across sessions.

**2b.1 Check existing:** `TaskList` → filter where `metadata.issue == N` ∧ `metadata.kind == 'dev-pipeline'`. ∃ matches → skip seeding (tasks already exist from a prior `/dev` invocation in this session). Cache {step → task.id} map from the matches. Goto 2b.4.

**2b.2 Build active sequence:** Apply Step 4 skip logic to τ + Σ. Skipped steps are **not** created — keeps the timeline clean.

Ordered step list:
```
triage → frame → analyze → spec → plan → implement → pr →
ci-watch → validate → review → fix → promote → cleanup
```

**2b.3 Create tasks:** ∀ step ∈ active_list:

```
TaskCreate(
  subject: "{step} — #{N} {title}",
  description: "{one-line step purpose from dev-process.mdx}",
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

Bar: `██`=done/skipped, `░░`=pending. Phases: Frame:{triage,frame} | Shape:{analyze,spec} | Build:{plan,implement,pr} | Verify:{ci-watch,validate,review,fix} | Ship:{promote,cleanup}

Status: `✓ {name}` (done) | `skipped` | `pending` | `→ next`.

## Step 4 — Skip Logic

```
should_skip(step, τ, Σ):
  triage   ∧ Σ.triage                    → skip (already done)
  frame    ∧ τ == S                       → skip
  analyze  ∧ τ ∈ {S, F-lite}             → skip (frame sufficient)
  spec     ∧ τ == S                       → skip
  plan     ∧ τ == S                       → skip
  ci-watch ∧ ¬PR ∃                         → skip
  fix      ∧ (Σ.fix ∨ Σ_s.fix)            → skip (fixes already applied)
  promote                                  → skip (/promote is standalone staging→main; ¬auto-triggered by /dev)
  cleanup  ∧ ¬has_stale(N)               → skip
  default                                 → false
```

`--from <step>` ⇒ force-mark all prior steps skipped (warn once).

## Step 5 — Walk Steps + Find Next

```
STEPS = [
  (Frame,  triage,    issue-triage),
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
| S* == frame (Σ.triage ∧ ¬Σ.frame) | Show φ if ∃ draft, ask approval |
| S* == spec (Σ.frame ∧ ¬Σ.spec) | Gate after spec runs |
| S* == plan (Σ.spec ∧ ¬Σ.plan) | Gate after plan runs |
| S* == review | Post-review gate handled inside /code-review |

Gate fires → Step 7 skips its own prompt (gate IS confirmation). ¬double-prompt.

## Step 6b — Reasoning Audit (optional)

**Trigger:** `--audit` ∨ S* ∈ `workflow.reasoning_audit` (stack.yml). critical := {spec, plan, implement}.

audit ∧ S* ∈ critical → reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md). Gate ∃ for S* → audit **replaces** it (¬double-prompt). ¬pass `--audit` to child skills.
→ → DP(A) **Proceed** | **Adjust approach** (max 3 rounds) | **Abort** (→ skipped, Step 5)

¬audit ∨ S* ∉ critical → skip (Step 6 gate still applies).

## Step 7 — Execute Step

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
| triage | adv | `skill: "issue-triage", args: "N"` | frame |
| frame | gate | `skill: "frame", args: "--issue N"` | analyze (F-full) ∨ spec (F-lite) |
| analyze | adv | `skill: "analyze", args: "--issue N"` | spec |
| spec | gate | `skill: "spec", args: "--issue N"` | plan |
| plan | gate | `skill: "plan", args: "--issue N"` | implement (auto-chain after approval) |
| implement | adv | `skill: "implement", args: "--issue N"` | pr |
| pr | adv | `skill: "pr"` (auto-detects branch + issue) | ci-watch |
| ci-watch | adv | `skill: "ci-watch", args: "--pr {PR#}"` | validate |
| validate | adv | `skill: "validate"` | code-review |
| review | verdict | `skill: "code-review"` | APPROVED → merge → cleanup \| CHANGES_REQUESTED → fix |
| fix | loop | `skill: "fix", args: "#{PR_NUMBER}"` | code-review (max 2 iters, then Abort) |
| promote | — | `skill: "promote"` (standalone — never auto-triggered) | — |
| cleanup | adv | `skill: "cleanup", args: "--scope #N"` | pipeline complete |

**Skip to X** ⇒ → DP(A) **Proceed anyway** | **Cancel**. Missing artifacts → warn first. Proceed ⇒ mark prior steps skipped, S* = X.

**Stop** ⇒ "Stopped at {S*}. Run `/dev #N` to resume."

## Step 8 — Post-skill Re-scan

Skill returns → **IMMEDIATELY in the same turn, silently:**

1. `TaskUpdate(task_id_map[S*], status: "completed")`
2. `Σ_s[step] = true`
3. Goto Step 1 (re-scan Σ)
4. Execute Step 7 for new S*

**¬write** "Step X complete" message between skill return and re-scan.
**¬write** "Moving to Y" message between re-scan and Step 7.
**¬ask** anything. The next skill's first output IS your next message.
**¬summarize** what just happened. The task list reflects state.

Skill fails/aborts → leave task `in_progress` → present recovery decision via protocol (Pattern A): **Retry** | **Skip** | **Abort**.
Σ_s ensures within-session advancement for artifact-less steps (validate, review, fix).
Session restart → Σ_s = ∅ → artifact-less steps re-run. 2b.1 will find the existing tasks (status possibly `completed` from last run) and skip re-seeding.
gate → re-scan detects updated artifact → Step 6 gate → Step 7 immediately (¬second prompt).
adv → re-scan → Step 7 immediately.

## Phases + Gate Summary

| Phase | Steps | Gate after |
|-------|-------|-----------|
| Frame | triage → frame | frame approval (status: approved) |
| Shape | analyze → spec | spec approval |
| Build | plan → implement → pr | plan approval (then auto-chains implement → pr) |
| Verify | ci-watch → validate → review → fix | post-review: fix/merge/stop. Merge = feature→staging (via /code-review Phase 8). |
| Ship | promote → cleanup | promote always skipped. cleanup runs if worktree/branches stale. |

## Tier Skip Matrix

| Step | S | F-lite | F-full |
|------|---|--------|--------|
| triage | run | run | run |
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
- `--from <step>` ∧ missing deps → warn + → DP(A) **Proceed** | **Cancel**.
- Issue ¬∃ ∧ free text → frame-only mode. φ approved → → DP(A) **Create GitHub issue** | **Continue without**.
- S* == validate → Σ.validate always null. Σ_s advances within session. New session → re-runs.
- Multiple PRs for same issue → list, → DP(A) select which.

$ARGUMENTS
