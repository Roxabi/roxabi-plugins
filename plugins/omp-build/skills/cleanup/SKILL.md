---
name: cleanup
disable-model-invocation: true
argument-hint: '[--all | --report-only | --yes | --scope <#N>]'
description: OMP-only — clean branches/worktrees/remotes after merge-status verification; sweep stuck labels and orphan CI runs. Offered after land, never automatic.
version: 0.1.0
---

# Git Cleanup

Let: β := branch | ω := worktree | π := open PR | Π := protected branch (main/master/staging) | safe(β) ⟺ proven_merged(β) ∧ ¬π(β) | proven_merged(β) := regular_merge(β) ∨ verified_squash(β) | regular_merge(β) := `BASE..β` is empty | verified_squash(β) := gh reports a MERGED PR on β **and** that PR's head SHA is an ancestor of its merge commit | hinted(β) := a commit message on BASE contains `#N` or β's name — **not** a proof, since any commit may type the number | N := scope issue number (∅ if unscoped) | orphan_shell := leftover path under `~/.omp/worktrees/<repo>/` or `<principal>/.claude/worktrees/` that is **not** in `git worktree list` | principal := the first `git worktree list` entry, pinned to Π by `hooks/principal-branch-pre.cjs` and the `tool_call` guard in `omp/index.ts`

Safely clean local β, ω, and remote branches with **mandatory merge-status verification** before any deletion. End-of-session sweep also strips stuck pipeline labels from closed PRs, cancels long-queued CI runs, and surfaces **orphan worktree shells** that git no longer tracks.

## Where deletion happens — the whole list

Three steps in this body delete, and no others:

| Step | Command | Backstop |
|------|---------|----------|
| 5 | `git worktree remove` · `git branch -d` · `git branch -D` | git itself: `-d` refuses an unmerged β, and the remote copy survives the mistake |
| 5b-execute | `rmdir` · `rm -rf` on an orphan shell | none — outside git entirely; the guard is the registration check in `scan-orphan-worktree-shells.sh` |
| 6e | `git push origin --delete` | **none** — no unmerged check exists on the remote side, and after it there is no copy left |

Step 6e is the deletion that ends the work, so the evidence bar is set there and
the other steps inherit it: only proven_merged(β) reaches `safe_remote`. A hinted
β is reported as `probably_merged`, is never pre-selected, and never enters a
`safe_*` list. `analyze-branches.sh` itself deletes nothing — it classifies.

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
# `--report-only` promises zero mutations, and the default path here runs
# `git fetch --prune origin` — a write to refs/remotes/*. A cron-safe run takes
# the trade knowingly: a possibly stale mirror (and so a possibly stale BASE)
# rather than a write. Interactive runs still fetch, because the deletions that
# follow are priced on a fresh base.
FETCH_ARG=""
[ "$REPORT_ONLY" = true ] && FETCH_ARG="--no-fetch"

if [ -n "$SCOPE" ]; then
  bash skill://cleanup/analyze-branches.sh $FETCH_ARG --scope "$SCOPE"
else
  bash skill://cleanup/analyze-branches.sh $FETCH_ARG
fi
```

Use `--json` when you need structured output for scripting. `--no-fetch` is also the flag for tests, or when origin was fetched immediately before.

**Scoping (`--scope <#N>`):** restricts local/remote branches and worktrees to the ones belonging to issue N by an **anchored** issue-number match — the character before the number is start-of-string or `/`/`-`, and the character after is `/`, `-`, `_`, or end (`extract_issue_number()` in `analyze-branches.sh`). So `--scope 19` cannot pick up `feat/319-other`, and `--scope 1` cannot pick up issue #14's branch. Without `--scope`, behavior is unchanged (repo-wide).

The script analyzes ∀ β ∉ {Π, current branch} (∧ β ∈ scope N, if set) with these checks (base branch = `staging` if `origin/staging` exists, else `main` — `detect_base_branch`, sourced by the script from `skills/shared/lib.sh` as `${SCRIPT_DIR}/../shared/lib.sh`; `shared` is a plain directory in this plugin, not a skill, so there is no `skill://` URL that names it):

| Check | Implementation | Verdict |
|-------|----------------|---------|
| Merged into base? | `git log --oneline <base>..<branch>` empty | `merge_reason=regular` → **safe to delete** |
| Squash-merged, verified? | `gh pr list --state all` → `MERGED` on head **and** `git merge-base --is-ancestor <headRefOid> <mergeCommit>` | `merge_reason=squash_pr` → **safe to delete** |
| Message match only | `git log --grep` on issue# or branch name on base, or a `MERGED` PR whose ancestry could not be shown | `merge_reason=squash_grep` / `squash_pr_unverified` → **`probably_merged`**, never safe, never pre-selected |
| Has open PR? | Batched `gh pr list` indexed by `headRefName` | **No** — active work |
| Has worktree? | `git worktree list --porcelain` | Remove worktree first |
| Commits ahead | `git rev-list --count <base>..<branch>` | Shown on every row — non-zero on a merged row is work pushed *after* the merge |
| Last commit age | `git log -1 --format="%cr"` | Info only |

**A grep hit is not a merge.** `git log --grep "#50"` matches any commit that
*mentions* #50 — a plan, a revert, a TODO — so it says nothing about whether this
β's commits shipped. Treating it as proof is how an unmerged, pushed β reaches
`git push origin --delete`: git refuses the local `-d`, nothing refuses the
remote. Hence `merge_reason` travels with every row and the operator approves a
verdict, not a checkmark.

Emits section markers: `---local-branches---`, `---remote-branches---`, `---worktrees---`, `---safe-local---`, `---safe-remote---`, `---probably-local---`, `---probably-remote---`, plus a human `---summary-table---`. **Analyze-only** — it carries no deletion path at all.

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
  Branch              │ Merged │ Evidence   │ Ahead │ PR    │ Worktree  │ Last Commit  │ Action
  feat/19-auth        │ ✅ yes │ regular    │ 0     │ —     │ —         │ 3 days ago   │ 🗑 Safe to delete
  feat/33-i18n        │ ❌ no  │ none       │ 4     │ #42   │ ../repo-33│ 2 hours ago  │ ⚠️ Active work
  fix/old-bug         │ ✅ yes │ squash_pr  │ 0     │ #38   │ —         │ 2 weeks ago  │ 🗑 Safe to delete
  feat/50-thing       │ 🔎 hint│ squash_grep│ 1     │ —     │ —         │ 6 days ago   │ 🔎 Probably merged — verify
  experiment/test     │ ❌ no  │ none       │ 2     │ —     │ —         │ 1 month ago  │ ⚠️ Unmerged

Worktrees:
  Path                │ Branch        │ Status
  /home/user/project  │ main          │ Principal (keep)
  /home/user/rox-33   │ feat/33-i18n  │ Active PR #42

Legend: 🗑 = proven merged, safe to delete · 🔎 = a message matched, nothing is proven —
verify before deleting · ⚠️ = needs attention · 🔒 = protected
```

### 4. Ask for Confirmation

If `REPORT_ONLY=true` → skip this confirmation **and** Step 5 (zero deletions); Step 3's table is the report. Continue to Step 6.

→ present multi-select
- Present only safe(β) items as default selections — `action == safe_delete`, i.e. `merge_reason ∈ {regular, squash_pr}`
- Show unmerged β **and** `probably_merged` β separately with a warning; **NEVER auto-select either**
- ∃ unmerged β ∨ ∃ `probably_merged` β → separate question, explicit warning, naming the evidence (`squash_grep` = "a commit message mentioned it") and the commits-ahead count
- Always include "Skip / Do nothing"

### 5. Execute Cleanup

∀ confirmed deletion. **Each `<placeholder>` below is a value, never a fragment**:
it is substituted inside the quotes exactly as the analyser reported it, and the
`--` ends option parsing. A refname is attacker-controlled text — it arrives from
`git branch -r`, so it carries whatever a PR author typed — and an unquoted
`<branch>` makes it a shell command:

```bash
# ω ∃ for β → remove ω FIRST
git worktree remove -- "<path>"

git branch -d -- "<branch>"        # merged branches (safe)
git branch -D -- "<branch>"        # unmerged — only if explicitly confirmed

git worktree prune
```

Never run any of these against the principal's path or its branch.

### 5b. Orphan worktree shells

`git worktree list` only knows registered worktrees. After `git worktree remove`, leftovers stay behind in the two roots this plugin creates worktrees in — `~/.omp/worktrees/<repo>/` (`skills/build/workflow.js`) and `<principal>/.claude/worktrees/`:

| kind | Example | Safe cleanup |
|------|---------|--------------|
| `empty_parent` | `~/.omp/worktrees/roxabi-plugins/` empty | `rmdir` (or `rm -rf` if confirmed empty) |
| `unregistered` | partial dir (e.g. only `node_modules`) under either root and **not** in `git worktree list` | `rm -rf -- "<path>"` after confirm — **never** if the path is still a live registered ω |

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
rmdir -- "<path>" 2>/dev/null || rm -rf -- "<path>"   # rmdir first; rm -rf only if user confirmed content orphans
```

`<path>` is a value: quoted, after `--`, exactly the canonical path the scanner
emitted. The scanner canonicalises both sides of its registration check
(`realpath`), so a path reported here is the same spelling git has — a lexical
near-miss (a symlinked `$HOME`) would otherwise name a **live** worktree here.

**Safety:** never `rm -rf` a path that still appears in `git worktree list`. Never wipe a worktree root wholesale — only this repo's children.

### 6. Clean Remote Branches

Use `---remote-branches---` and `---safe-remote---` from Step 2 (`analyze-branches.sh`). Do **not** re-analyze manually.

**CRITICAL for squash merges**: `git branch -r --merged` will NOT detect squash-merged branches, so `analyze-branches.sh` verifies the PR instead: `MERGED` **and** the PR head SHA an ancestor of the merge commit (`merge_reason=squash_pr`). A branch whose only evidence is a `git log --grep` match is `probably_merged`, **not** safe — it never appears in `---safe-remote---`. Post-merge commits on a verified `MERGED` PR β still delete safely, but the row's `Ahead` count is those commits: ¬0 → ask before deleting the remote, because that push is the last copy.

#### 6c. Present remote summary table

```
Remote Branch Cleanup
═════════════════════

  Remote Branch                       │ Merged │ Evidence   │ Ahead │ Open PR │ Last Commit  │ Action
  origin/feat/19-auth                 │ ✅ yes │ regular    │ 0     │ —       │ 5 days ago   │ 🗑 Safe to delete
  origin/docs/28-coding-standards     │ ✅ yes │ squash_pr  │ 0     │ —       │ 1 week ago   │ 🗑 Safe to delete
  origin/feat/50-thing                │ 🔎 hint│ squash_grep│ 1     │ —       │ 6 days ago   │ 🔎 Probably merged — verify
  origin/feat/33-i18n                 │ ❌ no  │ none       │ 4     │ #42     │ 2 hours ago  │ ⚠️ Active work
  origin/experiment/test              │ ❌ no  │ none       │ 2     │ —       │ 1 month ago  │ ⚠️ Unmerged
```

#### 6d. Ask for confirmation

If `REPORT_ONLY=true` → skip this confirmation **and** Step 6e (zero remote deletions); Step 6c's table is the report. Continue to Step 7.

→ present multi-select: default-select **only** `---safe-remote---` (proven merged, ¬π); show `---probably-remote---` and unmerged β separately, never pre-selected; **NEVER auto-delete remote β**; always include "Skip / Keep all remote branches".

This is the deletion with no backstop: git refuses `branch -d` on unmerged work,
nothing refuses `push --delete`, and afterwards no copy remains. A
`probably_merged` β deleted here is gone on the evidence that someone typed its
issue number.

#### 6e. Execute remote cleanup

`<branch>` is a value, never a fragment — quoted, after `--`:

```bash
git push origin --delete -- "<branch>"
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
| `--report-only` | Gather and print findings; perform zero mutations (cron-safe) — Step 2 therefore passes `--no-fetch` and reads a possibly stale mirror rather than writing `refs/remotes/*` |
| `--yes` | Skip confirmation prompts for all destructive actions |
| `--scope <#N>` | Restrict branch/worktree analysis + cleanup (Steps 2–6) to issue N — anchored match, not a substring search (see Step 2). Steps 7–8 (label/CI sweeps) stay repo-wide — they are end-of-session hygiene, not per-issue. |

## Safety Rules

1. **NEVER delete `main`, `master`, or `staging`**
2. **NEVER delete the current branch**
3. **NEVER touch the principal worktree or the branch checked out in it**
4. **NEVER delete a branch with an open PR** unless explicitly confirmed
5. **NEVER delete an unmerged branch** without a separate, explicit confirmation
6. **ALWAYS show merge status *and its evidence*** before any deletion — `merge_reason` and commits-ahead on the row, never a bare checkmark
7. **A message match is not a merge.** Only `regular` and `squash_pr` reach `safe_delete`; `squash_grep` / `squash_pr_unverified` are `probably_merged` — shown, never pre-selected, never in `safe_local`/`safe_remote`
8. **ALWAYS use `git branch -d`** for merged branches; **`git branch -D` only** when user explicitly confirms unmerged deletion
9. **Every `<placeholder>` in a deletion command is a value, never a fragment** — quoted and after `--`. Refnames and paths are attacker-controlled text
10. **ALWAYS remove worktree before deleting its branch**
11. **NEVER delete remote branches automatically** — always require explicit confirmation per branch
12. **ALWAYS scan all remote branches** for stale merged branches, not just locally deleted ones
13. **`--report-only` = zero mutations** — no label edits, no run cancels, no branch deletes, and no `git fetch` (Step 2 runs with `--no-fetch`)
14. **NEVER auto-cancel runs on protected branches** (main/master/staging) — show as info only
15. **Degrade gracefully on `gh` permission errors** — report failure and continue; never abort entire sweep

## Edge Cases

- **Squash merges**: `git branch -d` won't detect squash merges → `analyze-branches.sh` checks the PR: `MERGED` **and** head SHA ancestor of the merge commit. A `git log --oneline --grep` match on β name or issue# is reported as `probably_merged` and requires a human verdict — it matches any commit that merely mentions the number.
- **Squash merges on remote**: `git branch -r --merged` does NOT detect squash merges → same verified-PR check. Post-merge commits on a verified `MERGED` PR are still safe to delete, and show as `Ahead > 0` so the operator sees what the push would take with it.
- **Deleted on the strength of a grep**: the failure this ordering exists to prevent — an unmerged, pushed β whose issue number appears in an unrelated commit on BASE, deleted from origin with no copy left. `safe_remote` therefore admits proofs only.
- **Remote tracking branches**: Step 6 scans **all** remote β independently — always require explicit confirmation.
- **Stale worktrees**: ω path ∉ disk → `git worktree prune`.
- **Invoked from inside ω**: the orphan scan anchors both roots on the **principal** (first `git worktree list` entry), not on `git rev-parse --show-toplevel` — inside a linked worktree the latter names the ω itself, and every scan would report zero.
- **Symlinked `$HOME`**: git records the *resolved* worktree path, the scan root is built from `$HOME`. Compared lexically a live registered ω reads as an orphan and 5b-execute `rm -rf`s it, so `scan-orphan-worktree-shells.sh` canonicalises both sides (`realpath`) before comparing and emits canonical paths.
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
