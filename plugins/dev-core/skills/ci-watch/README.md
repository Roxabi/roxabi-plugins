# ci-watch

Watch a GitHub Actions CI run live — emoji dashboard, failed log dump, and auto-merge watch.

## Why

After pushing a PR, you have to manually poll GitHub or wait for email notifications. `/ci-watch` streams the CI run in real time with a live emoji dashboard, dumps failed job logs on exit, and — if CI passes and auto-merge is enabled with a `reviewed` label — watches the PR until it merges automatically.

## Usage

```
/ci-watch                     Auto-detect current branch's CI run
/ci-watch 42                  Watch PR #42
/ci-watch --run 12345678      Watch a specific run ID
/ci-watch --branch feat/42    Watch a specific branch
/ci-watch --interval 15       Poll every 15 seconds
```

Triggers: `"watch ci"` | `"ci watch"` | `"watch the ci"` | `"watch run"` | `"monitor ci"`

## How it works

1. **Detect repo** — extracts `OWNER/REPO` from `git remote get-url origin`.
2. **Parse arguments** — maps flags to the underlying `ci-watch.sh` script.
3. **Stream output** — runs the script with a 10-minute timeout, streaming directly (no buffering).
4. **Report result** — exit 0 = passed, exit 1 = failed (logs printed above), exit 2 = cancelled.
5. **Auto-merge watch** — if PR has `autoMergeRequest` set and `reviewed` label, enters a merge-wait loop until PR state = `MERGED` or `CLOSED`.

## Exit codes

| Exit | Meaning |
|------|---------|
| 0 | CI passed |
| 1 | CI failed (logs printed) |
| 2 | CI cancelled |

## Chain position

**Predecessor:** `/pr` | **Successor:** `/validate`
