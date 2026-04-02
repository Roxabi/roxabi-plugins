---
name: cleanup
argument-hint: [--branches | --worktrees | --all]
description: Clean git branches/worktrees/remotes after merge-status verification. Triggers: "cleanup" | "clean branches" | "cleanup worktrees" | "remove stale branches".
version: 0.2.0
allowed-tools: Bash, Read, EnterWorktree, ExitWorktree, ToolSearch
---

# Git Cleanup

Let: β := branch | ω := worktree | π := open PR | Π := protected branch (main/master/staging) | safe(β) ⟺ fully_merged(β) ∧ ¬π(β) | merged(β) := regular_merge(β) ∨ squash_merge(β)

Safely clean local β, ω, and remote branches with **mandatory merge-status verification** before any deletion.

## Instructions

### 1. Gather State

```bash
git branch -vv
git worktree list                    # includes both .claude/worktrees/ and legacy parent-dir worktrees
gh pr list --state open 2>/dev/null || echo "No gh CLI or no remote"
git branch --show-current
# Configure {commands.worktree_list} in stack.yml if applicable
```

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

### 7. Final Report

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

  Remaining branches: main, feat/33-i18n, experiment/test
```

## Options

| Flag | Description |
|------|-------------|
| (none) / `--all` | Analyze both branches and worktrees |
| `--branches` | Only analyze branches |
| `--worktrees` | Only analyze worktrees |

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

## Edge Cases

- **Squash merges**: `git branch -d` won't detect squash merges → use `git log --oneline --grep` on β name or issue# in main.
- **Squash merges on remote**: `git branch -r --merged` does NOT detect squash merges → verify via issue# grep AND `gh pr list --state all --head <branch>` for `MERGED`. Post-merge commits on a `MERGED` PR → still safe.
- **Remote tracking branches**: Step 6 scans **all** remote β independently — always require explicit confirmation.
- **Stale worktrees**: ω path ∉ disk → `git worktree prune`.
- **EnterWorktree worktrees**: worktrees in `.claude/worktrees/` are session-managed — `git worktree list` shows them alongside legacy worktrees; clean with `git worktree remove` or `ExitWorktree` if in active session.

$ARGUMENTS
