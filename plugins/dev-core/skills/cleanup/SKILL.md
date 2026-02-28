---
name: cleanup
argument-hint: [--branches | --worktrees | --all]
description: Clean git branches/worktrees/remotes after merge-status verification. Triggers: "cleanup" | "clean branches" | "cleanup worktrees" | "remove stale branches".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion
---

# Git Cleanup

Safely clean up local branches, worktrees, and **remote branches** with **mandatory merge-status verification** before any deletion.

## Instructions

### 1. Gather State

Run all these commands and collect the output:

```bash
# All local branches with tracking info
git branch -vv

# All worktrees
git worktree list

# Open PRs (to avoid cleaning active work)
gh pr list --state open 2>/dev/null || echo "No gh CLI or no remote"

# Current branch
git branch --show-current

# Branch databases (if Postgres container is running)
docker exec roxabi-postgres psql -U roxabi -tc "SELECT datname FROM pg_database WHERE datname ~ '^roxabi_[0-9]+$'" 2>/dev/null
```

### 2. Analyze Each Branch

For every branch **except `main`/`master`/`staging`** and the current branch, determine:

| Check | Command | Safe to delete? |
|-------|---------|-----------------|
| Merged into main? | `git log --oneline main..<branch> \| head -5` | Yes if empty |
| Squash-merged? | `git log --oneline --grep="<branch-or-issue>" main \| head -5` | Yes if found |
| Has open PR? | Check `gh pr list` output | **No** — active work |
| Has worktree? | Check `git worktree list` output | Remove worktree first |
| Last commit age | `git log -1 --format="%cr" <branch>` | Info only |

**CRITICAL**: A branch is only safe to delete if it is **fully merged** (regular or squash merge) AND has **no open PR**.

### 3. Present Summary Table

Display a clear table with ALL branches:

```
Git Cleanup Summary
═══════════════════

Branches:
  Branch              │ Merged │ PR    │ Worktree │ Database     │ Last Commit  │ Action
  feat/19-auth        │ ✅ yes │ —     │ —        │ —            │ 3 days ago   │ 🗑 Safe to delete
  feat/33-i18n        │ ❌ no  │ #42   │ ../rox-33│ roxabi_33    │ 2 hours ago  │ ⚠️ Active work
  fix/old-bug         │ ✅ yes │ —     │ —        │ —            │ 2 weeks ago  │ 🗑 Safe to delete
  experiment/test     │ ❌ no  │ —     │ —        │ —            │ 1 month ago  │ ⚠️ Unmerged
  —                   │ —      │ —     │ —        │ roxabi_123   │ —            │ ⚠️ Orphan DB

Worktrees:
  Path                │ Branch          │ Status
  /home/user/project  │ main            │ Main (keep)
  /home/user/rox-33   │ feat/33-i18n    │ Active PR #42

Legend: 🗑 = safe to delete, ⚠️ = needs attention, 🔒 = protected
```

### 4. Ask for Confirmation

Use **AskUserQuestion** to let the user choose what to clean up:

- Present **only safe-to-delete items** as default selections
- Show **unmerged branches separately** with a warning
- **NEVER auto-select unmerged branches**
- Always include a "Skip / Do nothing" option

Example question structure:
- "Which branches should I delete?" (multi-select, safe branches pre-listed)
- If unmerged branches exist: "These branches are NOT merged. Delete anyway?" (separate question, explicit warning)

### 5. Execute Cleanup

For each confirmed deletion:

```bash
# Drop branch database (if exists)
cd <worktree-path>/apps/api && bun run db:branch:drop <issue_number>

# If branch has a worktree, remove worktree FIRST
git worktree remove <path>

# Delete the branch
git branch -d <branch>        # merged branches (safe)
git branch -D <branch>        # unmerged branches (only if explicitly confirmed)

# Prune worktree references
git worktree prune
```

### 6. Clean Remote Branches

Scan **all** remote branches for stale ones that can be cleaned up.

#### 6a. Gather remote branches

```bash
# Fetch and prune stale remote tracking refs
git fetch --prune origin

# List all remote branches except main/master/staging/HEAD
git branch -r | grep -v 'origin/main' | grep -v 'origin/master' | grep -v 'origin/staging' | grep -v 'origin/HEAD'

# Get open PR branch names (to exclude)
gh pr list --state open --json headRefName --jq '.[].headRefName' 2>/dev/null
```

#### 6b. Analyze each remote branch

For every remote branch **not associated with an open PR**, determine merge status:

| Check | Command | Safe to delete? |
|-------|---------|-----------------|
| Regular merge? | `git log --oneline main..origin/<branch> \| head -1` — empty = merged | Yes |
| Squash-merged? | Extract issue number from branch name, then `git log --oneline --grep="#<issue>" main \| head -1`. Also check `gh pr list --state all --head <branch> --json state --jq '.[0].state'` for `MERGED` status | Yes if found |
| Has open PR? | Check against open PR list from 6a | **No** — active work |

**CRITICAL for squash merges**: `git branch -r --merged` will NOT detect squash-merged branches. Always check both:
1. Issue number in main's commit history (`git log --grep="#<issue>"`)
2. PR state via `gh pr list --state all --head <branch>` — look for `MERGED`

A branch with commits after its PR was merged (e.g., post-merge review fixes) is still safe to delete if the PR is `MERGED`.

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

Use **AskUserQuestion**:

- Present all merged remote branches with no open PR as safe to delete
- Show unmerged remote branches separately with a warning
- **NEVER auto-delete remote branches** — always require explicit confirmation
- Always include a "Skip / Keep all remote branches" option

#### 6e. Execute remote cleanup

For each confirmed remote deletion:

```bash
git push origin --delete <branch>
```

### 7. Final Report

Show what was cleaned up:

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
6. **ALWAYS use `git branch -d`** (safe delete) for merged branches
7. **ONLY use `git branch -D`** (force delete) when user explicitly confirms unmerged deletion
8. **ALWAYS remove worktree before deleting its branch**
9. **NEVER delete remote branches automatically** — always require explicit confirmation per branch
10. **ALWAYS scan all remote branches** for stale merged branches, not just locally deleted ones

## Edge Cases

- **Squash merges**: `git branch -d` won't detect squash merges as merged. Use `git log --oneline --grep` to check if the branch name or issue number appears in main's history.
- **Remote tracking branches**: Step 6 scans **all** remote branches independently (not just locally deleted ones). Always require explicit confirmation before any remote deletion.
- **Squash merges on remote**: `git branch -r --merged` does NOT detect squash merges. Always verify via issue number grep in main history AND `gh pr list --state all --head <branch>` to check for `MERGED` status. A branch with post-merge commits (e.g., review fixes pushed after squash-merge) is still safe to delete if its PR is `MERGED`.
- **Stale worktrees**: If a worktree path no longer exists on disk, `git worktree prune` will clean it up.

$ARGUMENTS
