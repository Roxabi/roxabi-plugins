---
name: cleanup
disable-model-invocation: true
argument-hint: '[--all | --report-only | --yes | --scope <#N>]'
description: OMP-only — clean branches/worktrees/remotes after merge-status verification; sweep stuck labels and orphan CI runs. Offered after land, never automatic.
version: 0.1.0
---

# Git Cleanup

Let: β := branch | ω := worktree | π := open PR | Π := protected branch (main/master/staging) | safe(β) ⟺ fully_merged(β) ∧ ¬π(β) | merged(β) := regular_merge(β) ∨ squash_merge(β) | N := scope issue number (∅ if unscoped) | orphan_shell := leftover path under `~/.omp/worktrees/<repo>/` or `<principal>/.claude/worktrees/` that is **not** in `git worktree list` | principal := the first `git worktree list` entry, pinned to Π by `hooks/principal-branch-pre.cjs` and the `tool_call` guard in `omp/index.ts`

Safely clean local β, ω, and remote branches with **mandatory merge-status verification** before any deletion. End-of-session sweep also strips stuck pipeline labels from closed PRs, cancels long-queued CI runs, and surfaces **orphan worktree shells** that git no longer tracks.

## Where this sits — the optional tail

`/cleanup` is **offered**, never run on its own initiative:

- It is not part of the feature cycle. `/feature` lands a ticket and stops. Nothing
  in the review→fix loop may reach this skill: a loop that deletes branches between
  review rounds deletes the branch under review.
- The operator invokes it. No path from `/feature`, `skill://dev-review` or
  `skill://fix` runs it automatically, and none may be added.
- `disable-model-invocation: true` omits this skill from the prompt listing on omp —
  it is **not** a gate. The property that makes this user-only is the lane:
  `omp/index.ts` exposes `/cleanup` through `registerCommand`, which the model
  cannot call. `skill://cleanup` and `/skill:cleanup` still reach this body.

## Entry: parse $ARGUMENTS

At skill entry, before any other action:

```
REPORT_ONLY=false
YES=false
SCOPE=""
_next_is_scope=false
for arg in $ARGUMENTS; do
  if [ "$_next_is_scope" = true ]; then
    SCOPE="${arg#\#}"
    _next_is_scope=false
    continue
  fi
  case "$arg" in
    --report-only) REPORT_ONLY=true ;;
    --yes)         YES=true ;;
    --scope)       _next_is_scope=true ;;
    --scope=*)     SCOPE="${arg#--scope=}"; SCOPE="${SCOPE#\#}" ;;
  esac
done
```

`REPORT_ONLY=true` ⇒ **zero mutations** throughout all steps (cron-safe).  
`YES=true` ⇒ skip confirmation prompts for destructive actions (implies user already consented).  
If both set: `REPORT_ONLY` wins — no mutations.
`SCOPE=<N>` ⇒ restrict branch/worktree analysis (Steps 2–6) to issue N only — see below. `SCOPE=""` (default) ⇒ repo-wide, unchanged behavior.

## Instructions

### 1. Gather State

```bash
bash skill://cleanup/gather-state.sh
```

Emits: `current`, branch list with tracking info, worktree list, **orphan worktree shells** (`---orphan-worktree-shells---` via `scan-orphan-worktree-shells.sh`), open PRs, closed PRs with pipeline labels, and queued/stuck CI runs. Unscoped — always full-repo; Steps 7–8 (label/CI sweeps) and the orphan-shell scan consume gather-state as-is regardless of `--scope` (see Options).

### 2. Analyze Branches

```bash
if [ -n "$SCOPE" ]; then
  bash skill://cleanup/analyze-branches.sh --scope "$SCOPE"
else
  bash skill://cleanup/analyze-branches.sh
fi
```

Use `--json` when you need structured output for scripting. Use `--no-fetch` only in tests or when origin was fetched immediately before.

**Scoping (`--scope <#N>`):** restricts local/remote branches and worktrees to the ones belonging to issue N by an **anchored** issue-number match — the character before the number is start-of-string or `/`/`-`, and the character after is `/`, `-`, `_`, or end (`extract_issue_number()` in `analyze-branches.sh`). So `--scope 19` cannot pick up `feat/319-other`, and `--scope 1` cannot pick up issue #14's branch. Without `--scope`, behavior is unchanged (repo-wide).

The script analyzes ∀ β ∉ {Π, current branch} (∧ β ∈ scope N, if set) with these checks (base branch = `staging` if `origin/staging` exists, else `main` — `detect_base_branch` from `skill://shared/lib.sh`):

| Check | Implementation | Safe to delete? |
|-------|----------------|-----------------|
| Merged into base? | `git log --oneline <base>..<branch>` empty | Yes |
| Squash-merged? | `gh pr list --state all` → `MERGED` on head, or `git log --grep` on issue#/branch name | Yes if found |
| Has open PR? | Batched `gh pr list` indexed by `headRefName` | **No** — active work |
| Has worktree? | `git worktree list --porcelain` | Remove worktree first |
| Last commit age | `git log -1 --format="%cr"` | Info only |

Emits section markers: `---local-branches---`, `---remote-branches---`, `---worktrees---`, `---safe-local---`, `---safe-remote---`, plus a human `---summary-table---`. **Analyze-only** — it carries no deletion path at all.

**The principal is structurally out of reach.** Protected branches are dropped
*before* classification, so the branch checked out in the principal — pinned to
main/master/staging by the freeze guard — never enters `local_branches`, and
therefore can never appear in `safe_local`. A branch checked out in the invoking
worktree is labelled `current` for the same reason.

The script's one write is `git fetch --prune origin` (skipped by `--no-fetch`): it
drops `refs/remotes/*` entries whose upstream is already gone. That is a mirror
sync — no branch, local or remote, is removed — and BASE detection reads those refs,
so a stale mirror would misreport the base.

### 3. Present Summary Table

```
Git Cleanup Summary
═══════════════════

Branches:
  Branch              │ Merged │ PR    │ Worktree  │ Last Commit  │ Action
  feat/19-auth        │ ✅ yes │ —     │ —         │ 3 days ago   │ 🗑 Safe to delete
  feat/33-i18n        │ ❌ no  │ #42   │ ../repo-33│ 2 hours ago  │ ⚠️ Active work
  fix/old-bug         │ ✅ yes │ —     │ —         │ 2 weeks ago  │ 🗑 Safe to delete
  experiment/test     │ ❌ no  │ —     │ —         │ 1 month ago  │ ⚠️ Unmerged

Worktrees:
  Path                │ Branch        │ Status
  /home/user/project  │ main          │ Principal (keep)
  /home/user/rox-33   │ feat/33-i18n  │ Active PR #42

Legend: 🗑 = safe to delete, ⚠️ = needs attention, 🔒 = protected
```

### 4. Ask for Confirmation

If `REPORT_ONLY=true` → skip this confirmation **and** Step 5 (zero deletions); Step 3's table is the report. Continue to Step 6.

→ present multi-select
- Present only safe(β) items as default selections
- Show unmerged β separately with warning; **NEVER auto-select unmerged β**
- ∃ unmerged β → separate question with explicit warning
- Always include "Skip / Do nothing"

### 5. Execute Cleanup

∀ confirmed deletion:

```bash
# ω ∃ for β → remove ω FIRST
git worktree remove <path>

git branch -d <branch>        # merged branches (safe)
git branch -D <branch>        # unmerged — only if explicitly confirmed

git worktree prune
```

Never run any of these against the principal's path or its branch.

### 5b. Orphan worktree shells

`git worktree list` only knows registered worktrees. After `git worktree remove`, leftovers stay behind in the two roots this plugin creates worktrees in — `~/.omp/worktrees/<repo>/` (`skills/build/workflow.js`) and `<principal>/.claude/worktrees/`:

| kind | Example | Safe cleanup |
|------|---------|--------------|
| `empty_parent` | `~/.omp/worktrees/roxabi-plugins/` empty | `rmdir` (or `rm -rf` if confirmed empty) |
| `unregistered` | partial dir (e.g. only `node_modules`) under either root and **not** in `git worktree list` | `rm -rf <path>` after confirm — **never** if the path is still a live registered ω |

Source: `gather-state.sh` → `---orphan-worktree-shells---` (`path|kind|detail`). Scope is **this repo only**: the `~/.omp/worktrees/` child is named after the principal's directory, so a sibling checkout's worktrees are never listed, let alone offered for deletion.

#### 5b-present

```
Orphan worktree shells
══════════════════════

  Path                                              │ Kind          │ Detail
  ~/.omp/worktrees/roxabi-plugins                   │ empty_parent  │ empty worktree parent
  <principal>/.claude/worktrees/495-optional-tail   │ unregistered  │ content without git registration
  (none found)
```

If `REPORT_ONLY=true` → print table and skip deletion. Else → multi-select (default: all listed); always offer "Skip".

#### 5b-execute (confirmed only)

```bash
rmdir <path> 2>/dev/null || rm -rf <path>   # rmdir first; rm -rf only if user confirmed content orphans
```

**Safety:** never `rm -rf` a path that still appears in `git worktree list`. Never wipe a worktree root wholesale — only this repo's children.

### 6. Clean Remote Branches

Use `---remote-branches---` and `---safe-remote---` from Step 2 (`analyze-branches.sh`). Do **not** re-analyze manually.

**CRITICAL for squash merges**: `git branch -r --merged` will NOT detect squash-merged branches. `analyze-branches.sh` already checks PR `MERGED` state and issue# grep. Post-merge commits on a `MERGED` PR β → still safe to delete.

#### 6c. Present remote summary table

```
Remote Branch Cleanup
═════════════════════

  Remote Branch                       │ Merged │ Open PR │ Last Commit  │ Action
  origin/feat/19-auth                 │ ✅ yes │ —       │ 5 days ago   │ 🗑 Safe to delete
  origin/docs/28-coding-standards     │ ✅ yes │ —       │ 1 week ago   │ 🗑 Safe to delete
  origin/feat/33-i18n                 │ ❌ no  │ #42     │ 2 hours ago  │ ⚠️ Active work
  origin/experiment/test              │ ❌ no  │ —       │ 1 month ago  │ ⚠️ Unmerged
```

#### 6d. Ask for confirmation

If `REPORT_ONLY=true` → skip this confirmation **and** Step 6e (zero remote deletions); Step 6c's table is the report. Continue to Step 7.

→ present multi-select present merged remote β with ¬π as safe; show unmerged separately; **NEVER auto-delete remote β**; always include "Skip / Keep all remote branches".

#### 6e. Execute remote cleanup

```bash
git push origin --delete <branch>
```

### 7. Sweep: stuck pipeline labels on closed/merged PRs

Pipeline labels should be removed when a PR is closed or merged. This step identifies and strips them.

#### Pipeline label list

This list is free-standing: omp-build ships no second copy to drift against.

```
PRIORITY_LABELS : P0-critical  P1-high  P2-medium  P3-low
SIZE_LABELS     : size:S  size:F-lite  size:F-full
LANE_LABELS     : graph:lane/a1  graph:lane/a2  graph:lane/a3
                  graph:lane/b
                  graph:lane/c1  graph:lane/c2  graph:lane/c3
                  graph:lane/d  graph:lane/e  graph:lane/f
                  graph:lane/g  graph:lane/h  graph:lane/i
                  graph:lane/j  graph:lane/k  graph:lane/l
                  graph:lane/m  graph:lane/n  graph:lane/o
                  graph:lane/standalone
STATUS_LABELS   : status:Backlog  status:Analysis  status:Specs
                  "status:In Progress"  status:Review  status:Done
PIPELINE_OTHER  : reviewed
```

All of the above are "pipeline labels" — they should not remain on closed/merged PRs.

#### 7a. Find candidates (from gather-state.sh `---closed-prs-with-labels---` section)

The script emits at most 20 closed PRs. For each, check which labels from the pipeline label list are present.

#### 7b. Present findings

```
Stuck Labels on Closed PRs
══════════════════════════

  PR    │ Title (truncated)          │ Labels to remove
  #123  │ feat: add auth module       │ status:In Progress, P2-medium
  #117  │ fix: broken build           │ reviewed, status:Review
  (none found)
```

If `REPORT_ONLY=true` → print table and **stop this step** (zero mutations).

#### 7c. Confirm and strip

→ present multi-select
- Default: strip all listed labels from all listed PRs
- "Skip / Keep labels as-is" always available

If `YES=true` → proceed without prompt.

For each confirmed PR + label:

```bash
gh pr edit <number> --remove-label "<label>"
```

Gracefully handle `gh` permission errors — report which labels could not be removed and continue.

### 8. Sweep: queued/stuck CI runs

#### 8a. Find candidates (from gather-state.sh `---queued-runs---` section)

The script emits at most 30 runs filtered to `queued` or `in_progress` status. Consider a run "stuck" if:
- status = `queued` and created ≥ 30 min ago, OR
- status = `in_progress` and created ≥ 60 min ago (use run's `createdAt` field)

#### 8b. Present findings

```
Queued / Stuck CI Runs
══════════════════════

  Run ID    │ Workflow              │ Branch              │ Status      │ Age
  12345678  │ ci.yml                │ feat/old-branch     │ queued      │ 2h 15m
  12345679  │ release.yml           │ main                │ in_progress │ 75m
  (none found)
```

If `REPORT_ONLY=true` → print table and **stop this step** (zero mutations).

#### 8c. Confirm and cancel

→ present multi-select
- Present stuck runs as candidates; runs on protected branches (main/master/staging) shown as informational — NEVER auto-cancel
- "Skip / Cancel none" always available

If `YES=true` → proceed without prompt (still skips protected branches).

For each confirmed run:

```bash
gh run cancel <run-id> 2>/dev/null || echo "⚠️  Cannot cancel run <run-id> (permission denied or already completed)"
```

Always degrade gracefully — permission errors are non-fatal; report and continue.

### 9. Final Report

```
Cleanup Complete
════════════════
  Local:
    ✅ Deleted branch: feat/19-auth
    ✅ Deleted branch: fix/old-bug
    ⏭ Skipped: feat/33-i18n (active PR)
    ⏭ Skipped: experiment/test (unmerged, user chose to keep)

  Orphan shells:
    ✅ Removed empty parent: ~/.omp/worktrees/roxabi-plugins
    ⏭ Skipped: (none)

  Remote:
    ✅ Deleted remote: origin/feat/19-auth
    ✅ Deleted remote: origin/docs/28-coding-standards
    ⏭ Skipped remote: origin/feat/33-i18n (active PR #42)

  Labels:
    ✅ Stripped: #123 — status:In Progress, P2-medium
    ⏭ Skipped: #117 (user chose to keep)

  CI Runs:
    ✅ Cancelled: run 12345678 (feat/old-branch, queued 2h 15m)
    ⏭ Skipped: run 12345679 (main — protected branch)

  Remaining branches: main, feat/33-i18n, experiment/test
```

If `REPORT_ONLY=true`, prefix the header with `[report-only — no mutations performed]`.

## Options

| Flag | Description |
|------|-------------|
| (none) / `--all` | Analyze branches, worktrees, labels, and runs |
| `--report-only` | Gather and print findings; perform zero mutations (cron-safe) |
| `--yes` | Skip confirmation prompts for all destructive actions |
| `--scope <#N>` | Restrict branch/worktree analysis + cleanup (Steps 2–6) to issue N — anchored match, not a substring search (see Step 2). Steps 7–8 (label/CI sweeps) stay repo-wide — they are end-of-session hygiene, not per-issue. |

## Safety Rules

1. **NEVER delete `main`, `master`, or `staging`**
2. **NEVER delete the current branch**
3. **NEVER touch the principal worktree or the branch checked out in it**
4. **NEVER delete a branch with an open PR** unless explicitly confirmed
5. **NEVER delete an unmerged branch** without a separate, explicit confirmation
6. **ALWAYS show merge status** before any deletion
7. **ALWAYS use `git branch -d`** for merged branches; **`git branch -D` only** when user explicitly confirms unmerged deletion
8. **ALWAYS remove worktree before deleting its branch**
9. **NEVER delete remote branches automatically** — always require explicit confirmation per branch
10. **ALWAYS scan all remote branches** for stale merged branches, not just locally deleted ones
11. **`--report-only` = zero mutations** — no label edits, no run cancels, no branch deletes
12. **NEVER auto-cancel runs on protected branches** (main/master/staging) — show as info only
13. **Degrade gracefully on `gh` permission errors** — report failure and continue; never abort entire sweep

## Edge Cases

- **Squash merges**: `git branch -d` won't detect squash merges → use `git log --oneline --grep` on β name or issue# in main.
- **Squash merges on remote**: `git branch -r --merged` does NOT detect squash merges → verify via issue# grep AND `gh pr list --state all --head <branch>` for `MERGED`. Post-merge commits on a `MERGED` PR → still safe.
- **Remote tracking branches**: Step 6 scans **all** remote β independently — always require explicit confirmation.
- **Stale worktrees**: ω path ∉ disk → `git worktree prune`.
- **Invoked from inside ω**: the orphan scan anchors both roots on the **principal** (first `git worktree list` entry), not on `git rev-parse --show-toplevel` — inside a linked worktree the latter names the ω itself, and every scan would report zero.
- **Orphan shells after remove**: `git worktree remove` does not delete empty parent dirs. Step 5b + `scan-orphan-worktree-shells.sh` cover these.

## Chain Position

- **Phase:** Ship (optional tail)
- **Predecessor:** — standalone. The operator runs it; nothing chains into it.
- **Successor:** — none
- **Class:** standalone. `/feature` may *offer* it after a ticket lands; offering is
  printing a line and stopping. It is never entered from the review→fix loop, where
  deleting a branch would delete the branch under review.

## Exit

- **Success:** print summary (branches deleted, worktrees pruned, labels stripped, runs cancelled). Stop.
- **`--report-only`:** print findings report, no mutations. Exit 0.
- **Failure:** return error to the operator. There is no orchestrator to recover into.

$ARGUMENTS
