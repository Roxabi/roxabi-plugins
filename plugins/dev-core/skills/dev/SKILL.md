---
name: dev
argument-hint: '[#N | "idea" | --from <step> | --audit]'
description: Workflow orchestrator — single entry point for the full dev lifecycle. Triggers: "dev" | "start working on" | "work on issue" | "develop".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, Skill, ToolSearch, AskUserQuestion
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

Single entry point: scan artifacts → detect state → show progress → delegate to step skill → loop.
¬rewrite step skill logic. ¬auto-advance phases. AskUserQuestion at each gate.

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
¬∃ → AskUserQuestion: **Create issue** | **Proceed without issue** (frame-only).

Free text ⇒ slug from text:
```bash
gh issue list --search "{text}" --json number,title,state --jq '.[:3]'
```
∃ match → AskUserQuestion: **Use #{N}: {title}** | **Create new** | **Proceed without issue**.

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
# Issue
gh issue view N --json state 2>/dev/null && echo "triage=true"

# Frame (handles both {N}-{slug}.mdx and {slug}.mdx patterns)
ls artifacts/frames/ 2>/dev/null | grep -iE "^{N}-{slug}|^{slug}"

# Analysis
ls artifacts/analyses/ 2>/dev/null | grep -E "^{N}-|{slug}"

# Spec
ls artifacts/specs/ 2>/dev/null | grep "^{N}-"

# Plan
ls artifacts/plans/ 2>/dev/null | grep "^{N}-"

# Worktree (check both .claude/worktrees/ and legacy parent-dir worktrees)
REPO=$(gh repo view --json name --jq '.name')
git worktree list | grep -E "${REPO}-{N}|worktrees/{N}-"

# Branch
git branch -a | grep "{N}-{slug}"

# PR
gh pr list --search "#{N}" --json number,state,reviewDecision,merged --jq '.[]'

# Review comment marker (fallback when reviewDecision is null)
gh pr view {PR#} --json comments --jq '.comments[].body' 2>/dev/null | grep -q "^## Code Review" && echo "review_comment=true"

# Fix comment marker (fallback for fix detection)
gh pr view {PR#} --json comments --jq '.comments[].body' 2>/dev/null | grep -q "^## Review Fixes Applied" && echo "fix_comment=true"
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
  validate:  null,         # no artifact — uses Σ_s only
  review:    PR ∃ ∧ (PR.reviewDecision ∈ ('APPROVED','CHANGES_REQUESTED') ∨ pr_has_review_comment(PR)),
  fix:       PR ∃ ∧ pr_has_fix_comment(PR),
  promote:   skipped,  # /promote is standalone staging→main. ¬part of feature cycle. Skip unless explicitly requested.
  cleanup:   ¬worktree ∃ ∧ ¬stale_branch ∃,
}

Σ_s = {} initially. Populated in Step 8 after each skill completes. Lost on restart.
Σ[step] == null → relies on Σ_s for within-session advancement.

pr_has_review_comment(PR) ⟺ PR comments ∃ body starting with "## Code Review"
pr_has_fix_comment(PR)    ⟺ PR comments ∃ body starting with "## Review Fixes Applied"

τ = φ.tier || issue_size_label_to_tier(issue.labels) || null

## Step 2 — Determine Tier

τ ∃ → skip.
¬τ → AskUserQuestion: **S** (≤3 files, no arch) | **F-lite** (clear scope, 1 domain) | **F-full** (complex, multi-domain).

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

Bar: `██` per completed/skipped, `░░` per pending. Phase steps:
- Frame: triage, frame
- Shape: analyze, spec
- Build: plan, implement, pr
- Verify: validate, review, fix
- Ship: promote, cleanup

Status: `✓ {name}` (done) | `skipped` | `pending` | `→ next`.

## Step 4 — Skip Logic

```
should_skip(step, τ, Σ):
  triage   ∧ Σ.triage                    → skip (already done)
  frame    ∧ τ == S                       → skip
  analyze  ∧ τ ∈ {S, F-lite}             → skip (frame sufficient)
  spec     ∧ τ == S                       → skip
  plan     ∧ τ == S                       → skip
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
| S* == review | Post-review gate handled inside /review |

Gate fires → Step 7 skips its own prompt (gate IS confirmation). ¬double-prompt.

## Step 6b — Reasoning Audit (optional)

**Trigger:** `--audit` ∨ S* ∈ `stack.yml` `workflow.reasoning_audit` list.

Let: critical_steps := {spec, plan, implement}.

audit_enabled ∧ S* ∈ critical_steps → present reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md), using field guidance for S*.

**Merge rule:** Step 6 gate ∃ for S* → audit **replaces** gate — single combined AskUserQuestion. ¬two consecutive prompts.

→ AskUserQuestion: **Proceed** | **Adjust approach** (max 3 rounds) | **Abort step** (→ skipped, return to Step 5)

¬audit_enabled ∨ S* ∉ critical_steps → skip to Step 7 (Step 6 gate still applies independently).

**Important:** ¬pass `--audit` to child skills in Step 7. Audit fires at orchestrator level only. ¬double-gate.

## Step 7 — Execute Step

```
gate_steps    := {frame, spec, plan}
auto_advance  := {triage, analyze, implement, pr, validate, review, fix, cleanup}
```

**gate_steps:** Step 6 already AskUserQuestion'd → invoke skill immediately. ¬double-prompt.
**auto_advance:** Show `→ Running {S*}…`, invoke immediately. ¬AskUserQuestion.
**Exception:** user may type "stop"/"skip to X" before skill completes.

**Skill invocation map:**

| Step | Skill invocation |
|------|-----------------|
| triage | `skill: "issue-triage", args: "N"` (set size + priority) |
| frame | `skill: "frame", args: "--issue N"` |
| analyze | `skill: "analyze", args: "--issue N"` |
| spec | `skill: "spec", args: "--issue N"` |
| plan | `skill: "plan", args: "--issue N"` |
| implement | `skill: "implement", args: "--issue N"` |
| pr | `skill: "pr"` (auto-detects branch + issue from worktree context) |
| validate | `skill: "validate"` (runs in current worktree) |
| review | `skill: "review"` (auto-detects PR from current branch) |
| fix | `skill: "fix", args: "#{PR_NUMBER}"` (PR# from Σ scan) |
| promote | `skill: "promote"` (standalone staging→main — skipped by default) |
| cleanup | `skill: "cleanup", args: "--scope #N"` (scoped to current issue's branch/worktree) |

**Skip to X** ⇒ AskUserQuestion: **Proceed anyway** | **Cancel**. Missing artifacts → warn first. Proceed ⇒ mark prior steps skipped, S* = X.

**Stop** ⇒ "Stopped at {S*}. Run `/dev #N` to resume."

## Step 8 — Post-skill Re-scan

Skill completes → Σ_s[step] = true → goto Step 1 (re-scan Σ).
Σ_s ensures within-session advancement for artifact-less steps (validate, review, fix).
Session restart → Σ_s = ∅ → artifact-less steps re-run (desired: results go stale).
Gates (frame, spec, plan) → re-scan detects updated artifact → progress → Step 6 gate → Step 7 immediately (¬second prompt).
auto_advance → re-scan → progress → Step 7 immediately.

## Phases + Gate Summary

| Phase | Steps | Gate after |
|-------|-------|-----------|
| Frame | triage → frame | frame approval (status: approved) |
| Shape | analyze → spec | spec approval |
| Build | plan → implement → pr | plan approval (then auto-chains implement → pr) |
| Verify | validate → review → fix | post-review: fix/merge/stop. Merge = feature→staging (via /review Phase 8). |
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
| validate | run | run | run |
| review | run | run | run |
| fix | cond | cond | cond |
| promote | cond | cond | cond |
| cleanup | cond | cond | cond |

cond = run only if applicable (see skip logic).

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
- `--from <step>` ∧ missing deps → warn + AskUserQuestion: **Proceed** | **Cancel**.
- Issue ¬∃ ∧ free text → frame-only mode. φ approved → AskUserQuestion: **Create GitHub issue** | **Continue without**.
- S* == validate → Σ.validate always null. Σ_s advances within session. New session → re-runs.
- Multiple PRs for same issue → list, AskUserQuestion: select which.

$ARGUMENTS
