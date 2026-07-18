---
name: ci-watch
description: 'Watch a CI run with live status + emoji dashboard; dump logs on failure; watch auto-merge if CI green + auto-merge enabled + "reviewed" label. Triggers: "watch ci" | "ci watch" | "watch the ci" | "watch run" | "monitor ci".'
version: 0.1.0
argument-hint: '[PR# | --run ID | --branch NAME] [--interval N]'
allowed-tools: Bash, Glob, Grep, Read
---

# CI Watch

Let:
  Φ  := `${CLAUDE_PLUGIN_ROOT}`
  SCR := `${Φ}/scripts/ci-watch.sh`
  R  := OWNER/REPO (auto-detected from git remote)
  AM := auto-merge

Poll a GitHub Actions run, render a live emoji dashboard, dump failed logs on exit, and watch AM if CI is green, AM is enabled on the PR, and the PR has a `reviewed` label.

## Instructions

### 1. Detect repo

```bash
git remote get-url origin
```

Extract R from the URL (handles both HTTPS `https://github.com/OWNER/REPO.git` and SSH `git@github.com:OWNER/REPO.git`).

### 2. Parse arguments

Map `$ARGUMENTS` to script flags:

| Input | Flags passed |
|-------|-------------|
| bare number (e.g. `42`) | `--pr 42` |
| `--run ID` | `--run ID` |
| `--branch NAME` | `--branch NAME` |
| `--pr NUMBER` | `--pr NUMBER` |
| `--workflow NAME` | `--workflow NAME` |
| `--interval N` | `--interval N` |
| (none) | (omit — script auto-detects branch + `ci.yml` workflow) |

### 3. Run the script

```bash
bash SCR --repo R [flags]
```

Use a 600000ms timeout (10 min). Stream output directly — do not buffer.

### 4. Report result

- Exit 0 → confirm run passed (and, if AM was watched, the PR merged).
- Exit 1 → confirm run failed; note that failed logs were printed above.
- Exit 2 → confirm run was cancelled.
- Exit 4 → **CI passed but the PR did not merge** (closed / conflicts / auto-merge disabled / watch timed out). ¬a CI failure — do not offer Retry-CI. Route to a merge follow-up: rebase, resolve conflicts, or re-enable auto-merge.
- Non-zero (other) → report the exit code and raw conclusion.

### 5. Watch auto-merge (if applicable)

AM_eligible(pr) ⟺ PR# known ∧ `autoMergeRequest` ¬null ∧ label `reviewed` ∈ PR.

¬AM_eligible → exit after reporting CI passed.

∀ AM_eligible: enter merge-wait loop (live spinner) → exit once merged (0) ∨ green-CI-unmerged (4).
- `MERGED` → confirm PR merged automatically (exit 0).
- `CLOSED` / `DIRTY` (conflicts) / auto-merge disabled / watch timeout → exit 4 (see §4).
- `BEHIND` / `BLOCKED` / `UNSTABLE` → transient, keep polling (¬terminal).

Timeout: the loop self-bounds at `MERGE_WAIT_TIMEOUT` (script, 15 min) → graceful exit 4. This is only reachable if the **Bash timeout you pass exceeds CI-watch time + that bound** — when a PR is expected to auto-merge, allow a Bash timeout ≥ 20 min so the script's exit 4 fires instead of a hard SIGKILL.

## Chain Position

- **Phase:** Verify
- **Predecessor:** `/pr` (PR exists)
- **Successor:** `/validate`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none
- Follow-up: CI failure → `/dev` may create a re-run / fix follow-up task

## Exit

- **CI green via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce `/validate`. `/dev` re-scans and advances.
- **CI green standalone:** print one line: `CI passed. Next: /validate`. Stop.
- **CI failed/cancelled (exit 1/2):** return error. `/dev` presents Retry | Skip | Abort (or creates a follow-up fix task depending on failure type).
- **CI green but unmerged (exit 4):** ¬a CI failure — report the merge blocker (conflicts / closed / auto-merge off / timeout) and route to rebase / resolve / re-enable, ¬Retry-CI.

$ARGUMENTS
