---
name: cleanup
argument-hint: [--branches | --worktrees | --all | --report-only]
description: Clean git branches/worktrees/remotes after merge-status verification; sweep stuck pipeline labels and orphan CI runs. Triggers: "cleanup" | "clean branches" | "cleanup worktrees" | "remove stale branches".
version: 0.4.0
allowed-tools: Bash, Read, EnterWorktree, ExitWorktree, ToolSearch
---

# Git Cleanup

Let: β := branch | ω := worktree | π := open PR | Π := protected branch (main/master/staging) | safe(β) ⟺ fully_merged(β) ∧ ¬π(β) | merged(β) := regular_merge(β) ∨ squash_merge(β)

Safely clean local β, ω, and remote branches with **mandatory merge-status verification** before any deletion. End-of-session sweep also strips stuck pipeline labels from closed PRs and cancels long-queued CI runs.

## Entry: parse $ARGUMENTS

At skill entry, before any other action:

```
REPORT_ONLY=false
YES=false
for arg in $ARGUMENTS; do
  case "$arg" in
    --report-only) REPORT_ONLY=true ;;
    --yes)         YES=true ;;
  esac
done
```

`REPORT_ONLY=true` ⇒ **zero mutations** throughout all steps (cron-safe).  
`YES=true` ⇒ skip confirmation prompts for destructive actions (implies user already consented).  
If both set: `REPORT_ONLY` wins — no mutations.

## Instructions

### 1. Gather State

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/cleanup/gather-state.sh
```

Emits: `current`, branch list with tracking info, worktree list, open PRs, closed PRs with pipeline labels, and queued/stuck CI runs.

### 2. Analyze Each Branch

∀ β ∉ {Π, current branch}:

| Check | Command | Safe to delete? |
|-------|---------|-----------------|
| Merged into main? | `git log --oneline main..<branch> \| head -5` | Yes if empty |
| Squash-merged? | `git log --oneline --grep="<branch-or-issue>" main \| head -5` | Yes if found |
| Has open PR? | Check `gh pr list` output | **No** — active work |
| Has worktree? | Check `git worktree list` output | Remove worktree first |
| Last commit age | `git log -1 --format="%cr" <branch>` | Info only |

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
  /home/user/project  │ main          │ Main (keep)
  /home/user/rox-33   │ feat/33-i18n  │ Active PR #42

Legend: 🗑 = safe to delete, ⚠️ = needs attention, 🔒 = protected
```

### 4. Ask for Confirmation

→ DP(C)
- Present only safe(β) items as default selections
- Show unmerged β separately with warning; **NEVER auto-select unmerged β**
- ∃ unmerged β → separate question with explicit warning
- Always include "Skip / Do nothing"

### 5. Execute Cleanup

∀ confirmed deletion:

```bash
# Optional: project-specific teardown hook (e.g. DB branch drop)
# [ -n "{commands.worktree_teardown}" ] && {commands.worktree_teardown} <issue_number>

# ω ∃ for β → remove ω FIRST
# For .claude/worktrees/ (EnterWorktree-created): ExitWorktree(action: "remove") if in active session
# For legacy/manual worktrees: git worktree remove <path>
git worktree remove <path>

git branch -d <branch>        # merged branches (safe)
git branch -D <branch>        # unmerged — only if explicitly confirmed

git worktree prune
```

### 6. Clean Remote Branches

Scan **all** remote branches for stale ones.

#### 6a. Gather remote branches

```bash
git fetch --prune origin
git branch -r | grep -v 'origin/main' | grep -v 'origin/master' | grep -v 'origin/staging' | grep -v 'origin/HEAD'
gh pr list --state open --json headRefName --jq '.[].headRefName' 2>/dev/null
```

#### 6b. Analyze each remote branch

∀ remote β ∉ π-set:

| Check | Command | Safe to delete? |
|-------|---------|-----------------|
| Regular merge? | `git log --oneline main..origin/<branch> \| head -1` — empty = merged | Yes |
| Squash-merged? | Extract issue# from β name → `git log --oneline --grep="#<issue>" main \| head -1`; also `gh pr list --state all --head <branch> --json state --jq '.[0].state'` for `MERGED` | Yes if found |
| Has open PR? | Check against open PR list from 6a | **No** — active work |

**CRITICAL for squash merges**: `git branch -r --merged` will NOT detect squash-merged branches. Always check both:
1. Issue number in main's commit history (`git log --grep="#<issue>"`)
2. PR state via `gh pr list --state all --head <branch>` — look for `MERGED`

Post-merge commits on a `MERGED` PR β → still safe to delete.

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

→ DP(C) present merged remote β with ¬π as safe; show unmerged separately; **NEVER auto-delete remote β**; always include "Skip / Keep all remote branches".

#### 6e. Execute remote cleanup

```bash
git push origin --delete <branch>
```

### 7. Sweep: stuck pipeline labels on closed/merged PRs

Pipeline labels should be removed when a PR is closed or merged. This step identifies and strips them.

#### Pipeline label list

<!-- sync manually when plugins/dev-core/skills/shared/adapters/config-helpers.ts changes -->
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

→ DP(C)
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

→ DP(C)
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
| `--branches` | Only analyze branches |
| `--worktrees` | Only analyze worktrees |
| `--report-only` | Gather and print findings; perform zero mutations (cron-safe) |
| `--yes` | Skip confirmation prompts for all destructive actions |

## Safety Rules

1. **NEVER delete `main`, `master`, or `staging`**
2. **NEVER delete the current branch**
3. **NEVER delete a branch with an open PR** unless explicitly confirmed
4. **NEVER delete an unmerged branch** without a separate, explicit confirmation
5. **ALWAYS show merge status** before any deletion
6. **ALWAYS use `git branch -d`** for merged branches; **`git branch -D` only** when user explicitly confirms unmerged deletion
7. **ALWAYS remove worktree before deleting its branch**
8. **NEVER delete remote branches automatically** — always require explicit confirmation per branch
9. **ALWAYS scan all remote branches** for stale merged branches, not just locally deleted ones
10. **`--report-only` = zero mutations** — no label edits, no run cancels, no branch deletes
11. **NEVER auto-cancel runs on protected branches** (main/master/staging) — show as info only
12. **Degrade gracefully on `gh` permission errors** — report failure and continue; never abort entire sweep

## Edge Cases

- **Squash merges**: `git branch -d` won't detect squash merges → use `git log --oneline --grep` on β name or issue# in main.
- **Squash merges on remote**: `git branch -r --merged` does NOT detect squash merges → verify via issue# grep AND `gh pr list --state all --head <branch>` for `MERGED`. Post-merge commits on a `MERGED` PR → still safe.
- **Remote tracking branches**: Step 6 scans **all** remote β independently — always require explicit confirmation.
- **Stale worktrees**: ω path ∉ disk → `git worktree prune`.
- **EnterWorktree worktrees**: worktrees in `.claude/worktrees/` are session-managed — `git worktree list` shows them alongside legacy worktrees; clean with `git worktree remove` or `ExitWorktree` if in active session.

## Chain Position

- **Phase:** Ship
- **Predecessor:** merge (after `/code-review` APPROVED → merge)
- **Successor:** — (pipeline complete)
- **Class:** adv (tail — last step in `/dev` pipeline)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Success via `/dev`:** stale branches/worktrees removed → return control silently. ¬write summary. `/dev` re-scans, all steps done/skipped, shows completion banner.
- **Success standalone:** print summary (branches deleted, worktrees pruned, labels stripped, runs cancelled). Stop.
- **`--report-only`:** print findings report, no mutations. Exit 0.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

$ARGUMENTS
