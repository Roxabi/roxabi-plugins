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

- Exit 0 → confirm run passed (AM watch may follow — see step 5).
- Exit 1 → confirm run failed; note that failed logs were printed above.
- Exit 2 → confirm run was cancelled.
- Non-zero (other) → report the exit code and raw conclusion.

### 5. Watch auto-merge (if applicable)

AM_eligible(pr) ⟺ PR# known ∧ `autoMergeRequest` ¬null ∧ label `reviewed` ∈ PR.

¬AM_eligible → exit after reporting CI passed.

∀ AM_eligible: enter merge-wait loop (live spinner) → exit once PR state = `MERGED` ∨ `CLOSED`.
- `MERGED` → confirm PR merged automatically.
- `CLOSED` → warn PR closed without merging.

$ARGUMENTS
