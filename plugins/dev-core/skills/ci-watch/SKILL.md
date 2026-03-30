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

Poll a GitHub Actions run, render a live emoji dashboard, dump failed logs on exit, and watch auto-merge if CI is green, auto-merge is enabled on the PR, and the PR has a `reviewed` label.

## Instructions

### 1. Detect repo

```bash
git remote get-url origin
```

Extract `OWNER/REPO` from the URL (handles both HTTPS `https://github.com/OWNER/REPO.git` and SSH `git@github.com:OWNER/REPO.git`).

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
bash SCR --repo OWNER/REPO [flags]
```

Use a 600000ms timeout (10 min). Stream output directly — do not buffer.

### 4. Report result

- Exit 0 → confirm run passed (auto-merge watch may follow — see step 5).
- Exit 1 → confirm run failed; note that failed logs were printed above.
- Exit 2 → confirm run was cancelled.
- Non-zero (other) → report the exit code and raw conclusion.

### 5. Watch auto-merge (if applicable)

The script automatically watches for auto-merge after a CI pass when **all three** conditions hold:

1. A PR number is known (`--pr` was passed or inferred from the branch).
2. Auto-merge is enabled on the PR (`autoMergeRequest` is non-null).
3. The PR has a label named exactly `reviewed`.

If any condition is false the script exits immediately after reporting CI passed.

When all three hold, the script enters a merge-wait loop, printing a live spinner, and exits once the PR state becomes `MERGED` or `CLOSED`. Report the outcome to the user:

- `MERGED` → confirm the PR was merged automatically.
- `CLOSED` → warn the user the PR was closed without merging.

$ARGUMENTS
