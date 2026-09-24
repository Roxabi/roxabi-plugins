---
name: ci-watch
disable-model-invocation: true
description: Watch every check on a PR head, then the merge, with a deadline the script owns.
version: 0.1.0
---

# ci-watch

Watch the PR until it merges or a check fails. The script owns the deadline.
OMP's bash tool must not: call it with `async: true` and `timeout: 0`.

```bash
bash skill://ci-watch/ci-watch.sh <pr>
```

No plugin-root token. `skill://` resolves to the installed copy.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--timeout <n>s\|<n>m` | `30m` | Bounds the check phase and the merge phase together. Deadline → exit 5. |
| `--merge-mode merge-on-green\|native` | `landing.mode` in `.dev/stack.yml`, else `native` | merge-on-green watches the `reviewed` label. native watches `autoMergeRequest`. |
| `--repo owner/repo` | `gh repo view` | Target repository. |
| `--interval <seconds>` | `15` | Poll interval. |

Checks watched: every run on the PR head, or exactly `landing.required_checks` when that list is declared. A green result waits one more poll so a late run is not missed.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Merged, or nothing to watch (native mode, no auto-merge). |
| 1 | A check failed. Failed-job logs are printed. |
| 2 | Cancelled. |
| 3 | Another conclusion, including a skipped required check. |
| 4 | Green but unmerged. Under merge-on-green, the `reviewed` label disappearing is this code. |
| 5 | Deadline. Undetermined — re-run to resume. |

## Classifier

`ci-watch.sh --classify-merge-state STATE MSS MODE ELIGIBLE ELAPSED TIMEOUT` prints the exit code, or `WATCH` for a transient `BEHIND` / `BLOCKED` / `UNSTABLE`. No network.
