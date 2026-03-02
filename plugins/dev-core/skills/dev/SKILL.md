---
name: dev
argument-hint: '[#N | "idea" | --from <step>]'
description: Workflow orchestrator — single entry point for the full dev lifecycle. Triggers: "dev" | "start working on" | "work on issue" | "develop".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill
---

# Dev

Let:
  N    := issue number
  slug := kebab-case title slug
  τ    := tier (S | F-lite | F-full)
  Σ    := state map (step → bool | null), persisted via artifacts
  Σ_s  := session state map (step → bool), in-memory only, lost on restart
  S*   := next step to execute

Single entry point for the full dev lifecycle. Scans artifacts → detects state → shows progress → delegates to step skill → loops.
¬rewrites logic of step skills. ¬auto-advances phases. AskUserQuestion at each gate.

## Entry

```
/dev #42             → resume/start from issue number
/dev "dark mode"     → find or create issue, then start
/dev #42 --from spec → jump to specific step (warn if deps missing)
```

## Step 0 — Parse Input

`#N` ⇒ fetch issue:
```bash
gh issue view N --json number,title,labels,state
```
¬∃ issue ⇒ AskUserQuestion: **Create issue** | **Proceed without issue** (frame-only mode).

Free text ⇒ slug from text. Search for matching issue:
```bash
gh issue list --search "{text}" --json number,title,state --jq '.[:3]'
```
∃ match ⇒ AskUserQuestion: **Use #{N}: {title}** | **Create new issue** | **Proceed without issue**.

`--from <step>` ⇒ record override. Warn if prerequisite artifacts missing per table:

| Step | Required artifacts |
|------|-------------------|
| frame | issue (triage) |
| analyze | `artifacts/frames/{slug}.mdx` (approved) |
| spec | `artifacts/frames/{slug}.mdx` or `artifacts/analyses/{N}-{slug}.mdx` |
| plan | `artifacts/specs/{N}-{slug}.mdx` |
| implement | `artifacts/plans/{N}-{slug}.mdx` (or spec for S-tier) |
| pr | worktree with code changes |
| validate | PR ∃ |
| review | PR ∃ |
| fix | review findings (PR comment with "## Code Review") |

## Step 1 — Scan State (parallel, <3s)

Run all checks in parallel via Bash:

```bash
# Issue
gh issue view N --json state 2>/dev/null && echo "triage=true"

# Frame
ls artifacts/frames/ 2>/dev/null | grep -i "{slug}"

# Analysis
ls artifacts/analyses/ 2>/dev/null | grep -E "^{N}-|{slug}"

# Spec
ls artifacts/specs/ 2>/dev/null | grep "^{N}-"

# Plan
ls artifacts/plans/ 2>/dev/null | grep "^{N}-"

# Worktree
git worktree list | grep "roxabi-{N}"

# Branch
git branch -a | grep "{N}-{slug}"

# PR
gh pr list --search "#{N}" --json number,state,reviewDecision,merged --jq '.[]'

# Review comment marker (fallback when reviewDecision is null)
gh pr view {PR#} --json comments --jq '.comments[].body' 2>/dev/null | grep -q "^## Code Review" && echo "review_comment=true"

# Fix comment marker (fallback for fix detection)
gh pr view {PR#} --json comments --jq '.comments[].body' 2>/dev/null | grep -q "^## Review Fixes Applied" && echo "fix_comment=true"
```

Read frontmatter of φ (frame) if ∃ → extract `status`, `tier`.

Σ = {
  triage:    issue ∃,
  frame:     φ ∃ ∧ φ.status == 'approved',
  analyze:   analysis artifact ∃,
  spec:      spec artifact ∃,
  plan:      plan artifact ∃,
  implement: worktree ∃ ∧ branch has commits beyond staging,
  pr:        PR ∃,
  validate:  null,         # no artifact — uses Σ_s only
  review:    PR ∃ ∧ (PR.reviewDecision ∈ ('APPROVED','CHANGES_REQUESTED') ∨ pr_has_review_comment(PR)),
  fix:       PR ∃ ∧ pr_has_fix_comment(PR),
  promote:   skipped,  # /promote is staging→main (standalone). ¬part of feature /dev cycle. Always skip unless user explicitly requests.
  cleanup:   ¬worktree ∃ ∧ ¬stale_branch ∃,
}

Σ_s = {} initially. Populated in Step 8 after each skill completes. Lost on session restart.
Steps with Σ[step] == null (no artifact detection) rely on Σ_s for within-session advancement.

pr_has_review_comment(PR) := PR comments contain a body starting with "## Code Review"
pr_has_fix_comment(PR)    := PR comments contain a body starting with "## Review Fixes Applied"

τ = φ.tier || issue_size_label_to_tier(issue.labels) || null

## Step 2 — Determine Tier

τ already set ⇒ skip.
¬τ ⇒ AskUserQuestion: **S** (≤3 files, no arch) | **F-lite** (clear scope, 1 domain) | **F-full** (complex, multi-domain).

## Step 3 — Progress Display

Render progress bar to user:

```
## {title} (#{N})  [{τ}]

  Frame    {bar}  {step statuses}
  Shape    {bar}  {step statuses}
  Build    {bar}  {step statuses}
  Verify   {bar}  {step statuses}
  Ship     {bar}  {step statuses}

→ Next: {S*} — {one-line description}
```

Bar: `██` per completed/skipped step, `░░` per pending. Phase steps:
- Frame:  triage, frame
- Shape:  analyze, spec
- Build:  plan, implement, pr
- Verify: validate, review, fix
- Ship:   promote, cleanup

Step status: `✓ {name}` (done) | `skipped` | `pending` | `→ next`.

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

`--from <step>` ⇒ force-mark all prior steps as skipped for this run (warn user once).

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

Walk STEPS:
- Σ[step] == true ∨ Σ_s[step] == true ∨ should_skip(step) ⇒ mark done/skipped, continue
- First non-done, non-skipped ⇒ S* = step, stop walk

∀ steps done ⇒ display completion banner, exit loop.

## Step 6 — Gate Check

Before invoking S*, check if arriving at a gate:

| Gate trigger | Behavior |
|-------------|----------|
| S* == frame (Σ.triage && ¬Σ.frame) | Show frame doc if ∃ draft, ask approval |
| S* == spec (Σ.frame && ¬Σ.spec) | Will gate after spec runs |
| S* == plan (Σ.spec && ¬Σ.plan) | Will gate after plan runs |
| S* == pr (Σ.implement && ¬Σ.pr) | Confirm ready for PR |
| S* == review | Post-review gate handled inside /review |

## Step 7 — AskUserQuestion Loop

AskUserQuestion:
- **Continue → {S*}** ({one-line description})
- **Skip to...** → {list of remaining non-skipped steps}
- **Stop** → save progress (artifacts persist), exit

**Continue** ⇒ invoke step skill using dispatch table:

| Step | Skill invocation |
|------|-----------------|
| triage | `skill: "issue-triage", args: "set N --status Triage"` |
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
| cleanup | `skill: "cleanup"` (auto-detects stale worktrees/branches) |

**Skip to X** ⇒ warn if prerequisite artifacts for X are missing, then confirm:
AskUserQuestion: **Proceed anyway** | **Cancel skip**.
Proceed ⇒ mark all steps before X as skipped for this run, set S* = X, loop to Step 7.

**Stop** ⇒ inform: "Stopped at {S*}. Run `/dev #N` to resume from this point."

## Step 8 — Post-skill Re-scan

After skill completes → set Σ_s[step] = true → goto Step 1 (re-scan Σ from artifacts).
Σ_s ensures within-session advancement for steps without artifacts (validate, review, fix).
On session restart, Σ_s is empty → artifact-less steps re-run (desired: validate results go stale).
Gates (frame, spec, plan, post-implement) ⇒ re-scan will detect updated artifact state → show updated progress → loop.
¬auto-advance past a phase gate without AskUserQuestion.

## Phases + Gate Summary

| Phase | Steps | Gate after |
|-------|-------|-----------|
| Frame | triage → frame | frame approval (status: approved) |
| Shape | analyze → spec | spec approval |
| Build | plan → implement → pr | plan approval; post-implement confirm |
| Verify | validate → review → fix | post-review: fix/merge/stop. Merge = feature→staging (via /review Phase 8). |
| Ship | promote → cleanup | promote always skipped (/promote is standalone staging→main). cleanup runs if worktree/branches stale. |

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

All steps done/skipped ⇒

```
## Done — {title} (#{N})

  Frame    ██████████  ✓
  Shape    ██████████  ✓ (analyze skipped)
  Build    ██████████  ✓
  Verify   ██████████  ✓
  Ship     ██████████  ✓

Issue #{N} closed. Worktree cleaned up.
```

## Edge Cases

- Session dies mid-step → re-run `/dev #N`. Re-scan detects partial state. If artifact was half-written, step skill handles it (checks ∃ + status).
- `--from <step>` with missing deps → warn once: "Step X normally requires {dep artifact}. Proceeding anyway may produce incomplete output." AskUserQuestion: **Proceed** | **Cancel**.
- Issue ¬exists + free text → proceed in frame-only mode. After frame approved, AskUserQuestion: **Create GitHub issue now** | **Continue without issue**.
- S* == validate → Σ.validate is always null (no artifact). Within a session, Σ_s.validate advances past it. On resume (new session), validate re-runs (Σ_s lost).
- Multiple open PRs for same issue → show list, AskUserQuestion: select which PR to track.

$ARGUMENTS
