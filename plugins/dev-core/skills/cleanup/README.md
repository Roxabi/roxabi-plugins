# cleanup

Clean merged git branches, worktrees, and remote branches after merge-status verification.

## Why

After merging several PRs, local and remote branches accumulate. `/cleanup` audits every branch for merge status (including squash merges, which `git branch --merged` misses), shows a summary table with recommended actions, and safely deletes only what is confirmed merged — always requiring explicit confirmation for unmerged branches.

## Usage

```
/cleanup             Analyze and clean both branches and worktrees
/cleanup --branches  Only analyze branches
/cleanup --worktrees Only analyze worktrees
```

Triggers: `"cleanup"` | `"clean branches"` | `"cleanup worktrees"` | `"remove stale branches"`

## How it works

1. **Gather state** — `gather-state.sh` lists local branches (tracking info), worktrees, open PRs, closed PR labels, and queued CI runs.
2. **Analyze branches** — `analyze-branches.sh` batch-audits local + remote branches (regular merge, squash PR state, issue# grep, open PRs, worktrees). Outputs `---safe-local---` / `---safe-remote---` plus a summary table. Use `--json` for machine-readable output.
3. **Present summary table** — 🗑 Safe to delete | ⚠️ Active work | 🔒 Protected
4. **Confirm** — presents safe branches as default selections; unmerged branches listed separately with explicit warning; never auto-selects unmerged.
5. **Execute** — removes worktrees first (before deleting their branch), uses `git branch -d` for merged, `git branch -D` only on explicit confirmation.
6. **Remote cleanup** — uses `---safe-remote---` from step 2; asks for explicit confirmation per branch.
7. **Sweep** — strips stuck pipeline labels from closed PRs; cancels long-queued CI runs.

## Safety rules

- Never deletes `main`, `master`, or `staging`
- Never deletes the current branch
- Never deletes a branch with an open PR (unless explicitly confirmed)
- Never deletes an unmerged branch without a separate explicit confirmation
- Never deletes remote branches automatically — always confirms per branch

## Chain position

**Predecessor:** merge (after `/code-review` APPROVED) | **Last step in `/dev` pipeline**
