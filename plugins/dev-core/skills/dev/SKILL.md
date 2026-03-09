---
name: dev
argument-hint: '[#N | "idea" | --from <step> | --audit]'
description: Workflow orchestrator — single entry point for the full dev lifecycle. Triggers: "dev" | "start working on" | "work on issue" | "develop".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill, ToolSearch, AskUserQuestion
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

Single entry point for the full dev lifecycle. Scans artifacts → detects state → shows progress → delegates to step skill → loops.
¬rewrites logic of step skills. ¬auto-advances phases. AskUserQuestion at each gate.

## Entry

```
/dev #42             → resume/start from issue number
/dev "dark mode"     → find or create issue, then start
/dev #42 --from spec → jump to specific step (warn if deps missing)
/dev #42 --audit     → enable reasoning checkpoint before critical steps
/dev --cleanup-context → audit & clean CLAUDE.md, skills, memory (delegates to /cleanup-context)
```

## Step 0 — Parse Input

`--cleanup-context` ⇒ ∃ other flags → warn "Other flags ignored when --cleanup-context is used." Delegate: `skill: "cleanup-context"`. **Stop** (¬enter dev loop).

`#N` ⇒ fetch issue:
```bash
gh issue view N --json number,title,labels,state
```
¬∃ issue ⇒ AskUserQuestion: **Create issue** | **Proceed without issue** (frame-only mode).

Free text ⇒ slug from text. Search:
```bash
gh issue list --search "{text}" --json number,title,state --jq '.[:3]'
```
∃ match ⇒ AskUserQuestion: **Use #{N}: {title}** | **Create new issue** | **Proceed without issue**.

`--from <step>` ⇒ record override. Warn if prerequisite artifacts missing:

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

# Worktree (repo name is dynamic — detect once)
REPO=$(gh repo view --json name --jq '.name')
git worktree list | grep "${REPO}-{N}"

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
  implement: worktree ∃ (path: `../${REPO}-{N}`) ∧ branch has commits beyond staging,
  pr:        PR ∃,
  validate:  null,         # no artifact — uses Σ_s only
  review:    PR ∃ ∧ (PR.reviewDecision ∈ ('APPROVED','CHANGES_REQUESTED') ∨ pr_has_review_comment(PR)),
  fix:       PR ∃ ∧ pr_has_fix_comment(PR),
  promote:   skipped,  # /promote is staging→main (standalone). ¬part of feature /dev cycle. Always skip unless user explicitly requests.
  cleanup:   ¬worktree ∃ ∧ ¬stale_branch ∃,
}

Σ_s = {} initially. Populated in Step 8 after each skill completes. Lost on session restart.
Steps with Σ[step] == null rely on Σ_s for within-session advancement.

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

| Gate trigger | Behavior |
|-------------|----------|
| S* == frame (Σ.triage ∧ ¬Σ.frame) | Show φ if ∃ draft, ask approval |
| S* == spec (Σ.frame ∧ ¬Σ.spec) | Gate after spec runs |
| S* == plan (Σ.spec ∧ ¬Σ.plan) | Gate after plan runs |
| S* == review | Post-review gate handled inside /review |

Gate fires → Step 7 skips its own prompt for that step (gate IS the confirmation). ¬double-prompt.

## Step 6b — Reasoning Audit (optional)

**Trigger:** `--audit` flag ∨ `workflow.reasoning_audit` list in `stack.yml` includes S*.

audit_enabled ⟺ `--audit` flag ∨ S* ∈ stack.yml `workflow.reasoning_audit` list.
critical_steps := {spec, plan, implement}.

audit_enabled ∧ S* ∈ critical_steps → present reasoning audit per [reasoning-audit.md](../shared/references/reasoning-audit.md) template, using field guidance for S*.

**Merge rule:** if Step 6 already produced a gate for S* (spec, plan), the reasoning audit **replaces** the Step 6 gate — show audit display + single combined AskUserQuestion. ¬present two consecutive prompts for the same step.

→ AskUserQuestion: **Proceed** | **Adjust approach** (max 3 rounds) | **Abort step** (→ mark skipped, return to Step 5)

¬audit_enabled ∨ S* ∉ critical_steps → skip directly to Step 7 (Step 6 gate still applies independently).

**Important:** ¬pass `--audit` to child skill invocations in Step 7. The audit gate fires here (orchestrator level) only. Child skills have their own `--audit` for standalone use — ¬double-gate.

## Step 7 — Execute Step

```
gate_steps    := {frame, spec, plan}
auto_advance  := {triage, analyze, implement, pr, validate, review, fix, cleanup}
```

**gate_steps:** Step 6 already fired an AskUserQuestion for these — Step 7 skips its own prompt and invokes the skill immediately. ¬double-prompt.

**auto_advance:** No user decision needed. Show `→ Running {S*}…` and invoke skill immediately. ¬AskUserQuestion.

**Exception — always available via text input:** At any auto_advance step the user may type "stop" or "skip to X" in the Claude input before the skill completes. Honor it.

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

**Skip to X** ⇒ AskUserQuestion: **Proceed anyway** | **Cancel skip**. Missing prerequisite artifacts → warn first.
Proceed ⇒ mark all steps before X as skipped, S* = X, loop to Step 7.

**Stop** ⇒ "Stopped at {S*}. Run `/dev #N` to resume from this point."

## Step 8 — Post-skill Re-scan

skill completes → Σ_s[step] = true → goto Step 1 (re-scan Σ from artifacts).
Σ_s ensures within-session advancement for artifact-less steps (validate, review, fix).
session restart → Σ_s = ∅ → artifact-less steps re-run (desired: validate results go stale).
Gates (frame, spec, plan) → re-scan detects updated artifact state → show progress → Step 6 fires gate → Step 7 invokes skill immediately (¬second prompt).
auto_advance steps → re-scan → show progress → Step 7 invokes next skill immediately.

## Phases + Gate Summary

| Phase | Steps | Gate after |
|-------|-------|-----------|
| Frame | triage → frame | frame approval (status: approved) |
| Shape | analyze → spec | spec approval |
| Build | plan → implement → pr | plan approval (then auto-chains implement → pr) |
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

- session dies mid-step → re-run `/dev #N`. Re-scan detects partial state. half-written artifact → step skill handles (checks ∃ + status).
- `--from <step>` ∧ missing deps → warn: "Step X normally requires {dep artifact}. Proceeding may produce incomplete output." AskUserQuestion: **Proceed** | **Cancel**.
- issue ¬∃ ∧ free text → frame-only mode. φ approved → AskUserQuestion: **Create GitHub issue now** | **Continue without issue**.
- S* == validate → Σ.validate always null. Σ_s.validate advances within session. new session → validate re-runs (Σ_s lost).
- multiple open PRs for same issue → list, AskUserQuestion: select which PR to track.

$ARGUMENTS
