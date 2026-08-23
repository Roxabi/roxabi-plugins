---
name: ship
argument-hint: '[#PR | --draft | --base <branch> | --from <step> | --max-fix-iters N | --no-commit | --skip-cleanup]'
description: Meta-orchestrator to land ready code — commit → PR → code-review → fix loop → reviewed label + ci-watch. Triggers: "ship" | "ship this" | "land this" | "land the PR" | "ship PR" | "submit for merge" | "get this merged" | "ship my branch".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Ship

## Success

I := commits on feature branch ∧ PR ∃ ∧ agent review APPROVED (or clean after ≤K fix↔review iters) ∧ label `reviewed` ∧ CI green ∧ (auto-merge attempted ∨ merge path reported)
V := `gh pr view` state MERGED ∨ (CI green ∧ `reviewed` ∈ labels ∧ autoMergeRequest ≠ null) ∨ explicit Abort/Stop

Let:
  Β    := current branch (must ∉ {main, master, staging})
  β    := `staging` (∃ origin/staging) ∨ `main`
  P    := open PR for Β (number)
  K    := max fix↔review iterations (default **2**, override `--max-fix-iters N`)
  Σ_s  := session step map (in-memory only)
  ψ_r  := PR comments ∃ body starting with `## Code Review`
  ψ_f  := PR comments ∃ body starting with `## Review Fixes Applied`
  dirty := `git status --porcelain` non-empty
  ahead := `git rev-list --count origin/${β}..HEAD` > 0 (or unpushed commits on Β)
  bar  := same quality bar as `/dev` — hand-authored feel; QG = floor

**Not** a substitute for `/dev`. Use when **implementation is already done** (or nearly) and you want the gate path only:

```
commit → /pr → /dev-review → [/fix ↺ /dev-review]×≤K → label reviewed → /ci-watch → [/cleanup]
```

Compared to `/dev` Verify (`pr → ci-watch → validate → review → fix`):
- **Review before merge-gate** — agent review + fix loop first; `reviewed` + CI watch last
- **No** frame/spec/plan/implement/validate (optional: jump via `/dev --from …` if you need those)
- **Commit step** included (dirty tree → conventional commit + push)

¬rewrite child skill logic. ¬auto-merge mid-CI. Label `reviewed` is the merge gate (merge-on-green / `gh pr merge --auto --merge`).

## Entry

```
/ship                    → full pipeline from current branch
/ship #42                → bind to PR #42 (must match current branch head)
/ship --draft            → pass --draft to /pr
/ship --base staging     → pass --base to /pr
/ship --from review      → skip commit+pr if PR already exists
/ship --max-fix-iters 1  → cap fix↔review loops
/ship --no-commit        → refuse to create commits; dirty tree → halt
/ship --skip-cleanup     → after merge, do not run /cleanup
```

## Steps

```
commit → pr → review → fix ↺ review → label-reviewed → ci-watch → cleanup
```

| Step | Class | Skill / action | On success → |
|------|-------|----------------|--------------|
| commit | adv (inline) | conventional commit + push if dirty | pr |
| pr | adv | `skill: "pr"` (+ `--draft` / `--base` if set) | review |
| review | verdict | `skill: "dev-review"` | APPROVED → label-reviewed · CHANGES_REQUESTED → fix · Stop → halt |
| fix | loop | `skill: "fix", args: "#{P}"` | strip premature `reviewed` if present → review (iter++) |
| label-reviewed | adv (inline) | ensure auto-merge + `reviewed` label | ci-watch |
| ci-watch | adv | `skill: "ci-watch", args: "--pr {P}"` | cleanup (if merged ∨ green path) |
| cleanup | adv | `skill: "cleanup"` (scoped if issue# known) | done |

## Step 0 — Parse + Guard Rails

```
DRAFT=false; BASE=""; FROM=""; K=2; NO_COMMIT=false; SKIP_CLEANUP=false; PR_ARG=""
for arg in $ARGUMENTS; do
  case "$arg" in
    --draft) DRAFT=true ;;
    --base)  next is BASE ;;
    --base=*) BASE="${arg#--base=}" ;;
    --from)  next is FROM ;;
    --from=*) FROM="${arg#--from=}" ;;
    --max-fix-iters=*) K="${arg#--max-fix-iters=}" ;;
    --no-commit) NO_COMMIT=true ;;
    --skip-cleanup) SKIP_CLEANUP=true ;;
    \#[0-9]*|[0-9]*) PR_ARG="${arg#\#}" ;;
  esac
done
```

1. `git fetch origin ${β} --quiet` (best-effort)
2. Β ∈ {main, master, staging} → **REFUSE**: "Create/switch to a feature branch first."
3. Resolve P:
   - `PR_ARG` set → `gh pr view $PR_ARG --json number,headRefName,state,url`
   - else → `gh pr list --head "$Β" --state open --json number,url -q '.[0]'`
4. If `FROM` set ∈ {review, fix, label-reviewed, ci-watch, cleanup}: mark prior steps done in Σ_s; require P ∃ for any step after pr.

## Step 1 — Scan State

```
Σ_s defaults false. Detect:

  commit:  ¬dirty  (nothing to commit)  — still may have ahead commits
  pr:      P ∃ ∧ open
  review:  P ∃ ∧ (ψ_r ∨ reviewDecision ∈ {APPROVED, CHANGES_REQUESTED})
  fix:     P ∃ ∧ ψ_f  (last cycle; re-review may still be needed)
  label:   P ∃ ∧ label reviewed ∈ PR
  ci:      null (session)
  cleanup: null (session)
  iter:    0   # fix↔review iterations completed
```

Present short banner (no full /dev phase bars):

```
## Ship — {Β}  [PR #{P}|no PR]

  commit          {✓|→|skip}
  pr              {✓|→|pending}
  code-review     {✓|→|pending}  (iter {iter}/{K})
  fix             {cond}
  reviewed+CI     {✓|→|pending}
  cleanup         {✓|skip|pending}

→ Next: {S*}
```

## Step 2 — commit (inline)

**Skip if:** `--no-commit` ∧ ¬dirty · or ¬dirty (nothing to stage).

**If dirty ∧ `--no-commit`:** halt — "Working tree dirty; commit manually or drop `--no-commit`."

**If dirty:**
1. `git status -sb` + `git diff` / `git diff --staged` + `git log -5 --oneline`
2. Stage intentional paths only — ¬`git add -A` if secrets risk (same rule as `/fix`). Prefer explicit paths from status.
3. Message: Conventional Commits, focus on *why*. HEREDOC commit.
4. `git push -u origin HEAD` (or `git push` if upstream set).
5. Fail → Retry | Abort.

**If ¬dirty ∧ ¬ahead ∧ ¬P:** **REFUSE** — "Nothing to ship (clean tree, no commits ahead of base, no PR)."

**If ¬dirty ∧ ahead:** mark commit done; continue (already committed).

## Step 3 — pr

**Skip if:** P ∃ open for Β (unless user forced update — then invoke `/pr` which offers Update).

**Invoke:** `skill: "pr"` with args:
- `--draft` if DRAFT
- `--base {BASE}` if BASE set

On success: re-resolve P from `gh pr list --head "$Β"`. ¬P → halt.

**Silent via /ship:** no "Next: /ci-watch" from child — ship owns chaining.

## Step 4 — code-review

**Invoke:** `skill: "dev-review"` (PR auto-detected from branch).

Interpret Phase 8 outcome (user decision inside code-review when standalone; when driven by ship, prefer):

| Outcome | Ship action |
|---------|-------------|
| Clean / APPROVED / user picks **Merge as-is** | → **do not** let code-review label+merge alone if ship will own gate — if code-review already labeled, continue to ci-watch; else → label-reviewed |
| User picks **Fix now** / CHANGES_REQUESTED | → fix (if iter < K) |
| Stop / Abort | halt ship |
| F = ∅ clean approve | → label-reviewed |

**Important:** `/dev-review` Phase 8 may offer Merge as-is (label + auto-merge). Under `/ship`, that path is **allowed** and equivalent to label-reviewed + handoff; then ship still runs **ci-watch** to observe green + merge. If user already labeled inside code-review, skip duplicate label step.

## Step 5 — fix (loop)

**Enter only if:** review requested changes ∧ iter < K.

**Invoke:** `skill: "fix", args: "#{P}"`.

On success:
1. `iter := iter + 1`
2. **Strip premature merge gate** (fix Phase 7 may add `reviewed` before re-review):
   ```bash
   gh pr edit "$P" --remove-label reviewed 2>/dev/null || true
   ```
3. Goto Step 4 (code-review) for re-verify.

**iter ≥ K on entry to fix:** refuse another fix cycle — present **Merge as-is** (→ label-reviewed) | **Stop**.

## Step 6 — label-reviewed (inline)

**Skip if:** `reviewed` already on PR.

1. Rebase check (best-effort, same spirit as code-review Phase 8):
   ```bash
   git fetch origin ${β}
   # if behind: rebase + force-with-lease on feature branch only; conflict → halt
   ```
2. Enable auto-merge if supported:
   ```bash
   gh pr merge "$P" --auto --merge 2>/dev/null || true
   ```
   (¬plain merge while checks in progress)
3. Add label:
   ```bash
   gh api "repos/{owner}/{repo}/issues/${P}/labels" -f "labels[]=reviewed"
   ```
4. Confirm: `gh pr view $P --json labels,autoMergeRequest`

## Step 7 — ci-watch

**Invoke:** `skill: "ci-watch", args: "--pr ${P}"`  
Bash timeout ≥ 20 min when auto-merge expected (see ci-watch skill).

| Exit | Ship action |
|------|-------------|
| 0 merged / green+AM | → cleanup |
| 1 CI failed | present **Retry CI** (`gh run rerun`) \| **fix locally** \| **Abort** |
| 2 cancelled | report; Retry \| Abort |
| 4 green unmerged | report blocker (conflicts / AM off / timeout); **rebase** \| **re-label** \| **Abort** — ¬blind Retry-CI |

## Step 8 — cleanup

**Skip if:** `--skip-cleanup` ∨ PR not merged yet (still open) ∨ user declines.

**If PR merged:**
```
skill: "cleanup"
```
If issue number known from branch (`feat/42-…` → 42) or PR closing issues: prefer `skill: "cleanup", args: "--scope #N"`.

## Continuous-flow rules (same as /dev)

- **¬ask** "Ready to proceed to /X?"
- **¬summarize** "Just finished X, moving to Y"
- Child skills return → re-scan Σ_s → invoke next step same turn
- Exception: verdict/loop gates inside code-review and fix (human decisions stay)
- Exception: CI failure / merge blocker → present choice

## Task list (optional)

If TaskCreate available, seed `kind: "ship-pipeline"` tasks for active steps only (same pattern as `/dev` 2b, lighter). Metadata: `{ kind: "ship-pipeline", pr: P, step, iteration }`. ¬required for correctness.

## Options

| Flag | Description |
|------|-------------|
| (none) | Full pipeline on current branch |
| `#N` / `N` | Bind to PR number N |
| `--draft` | Create draft PR |
| `--base <branch>` | PR base override |
| `--from <step>` | `commit`\|`pr`\|`review`\|`fix`\|`label-reviewed`\|`ci-watch`\|`cleanup` |
| `--max-fix-iters N` | Default 2 |
| `--no-commit` | Never create commits |
| `--skip-cleanup` | Skip post-merge cleanup |

## Safety Rules

1. **NEVER** ship from `main` / `master` / `staging`
2. **NEVER** `git push --force` — only `--force-with-lease` on feature branch rebase
3. **NEVER** plain `gh pr merge` while checks IN_PROGRESS/QUEUED
4. **NEVER** leave `reviewed` on a PR that still needs re-review after `/fix` (strip before re-review)
5. **ALWAYS** cap fix↔review at K (default 2)
6. **ALWAYS** stage intentional files only on commit step
7. **NEVER** rewrite `/pr`, `/dev-review`, `/fix`, `/ci-watch`, `/cleanup` logic — delegate

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Dirty tree + secrets patterns | Halt; ask user to unstage |
| PR exists, local behind origin/Β | `git pull --ff-only` or halt on divergence |
| `/pr` REFUSE (no commits) | Halt with message |
| Review clean first try | Skip fix; label + ci-watch |
| Fix applies label early | Strip before re-review |
| AM not available on repo | Label still applied; ci-watch reports green; note manual merge path |
| Multiple open PRs for branch | Impossible normally; if API returns many, pick latest open |
| `--from review` without PR | REFUSE |

## Chain Position

- **Phase:** Ship (feature → base)
- **Predecessor:** ad-hoc implementation, or `/implement`, or end of `/dev` Build without Verify
- **Successor:** `/promote` (staging→main) when base was staging
- **Class:** meta-orchestrator (like `/dev`, narrower)

## Relation to `/dev`

| | `/dev` | `/ship` |
|---|--------|---------|
| Scope | issue lifecycle Frame→Ship | branch already has code |
| Order | pr → **ci-watch** → validate → **review** → fix | commit → pr → **review** → fix → **reviewed+ci-watch** |
| validate | yes | no |
| commit | via implement | explicit first step |
| Entry | `/dev #N` | `/ship` on feature branch |

Prefer `/ship` for hotfix / already-pushed work / agent sessions that coded first. Prefer `/dev` when artifacts (frame/spec/plan) matter.

## Exit

- **Merged:** print PR URL + base branch; if staging, hint `/promote` when ready. Stop.
- **CI green, AM pending:** print status; Stop (or keep watching if user asks).
- **Failure:** error + Retry \| Abort. Stop.
- **User Stop:** "Stopped at {S*}. Resume: `/ship --from {S*}`."

$ARGUMENTS
