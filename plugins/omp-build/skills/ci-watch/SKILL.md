---
name: ci-watch
disable-model-invocation: true
description: Watch every check on a PR head, then the merge, with a deadline the script owns.
version: 0.1.2
---

# ci-watch

While this host-owned watch is the only work running (no model turn), Esc/RPC does
not pause or disarm the feature workflow. Use `/feature pause` or `/feature abandon`;
session switch and shutdown still take the durable pause path.

Watch the PR until it merges or a check fails. The script owns the deadline.
OMP's bash tool must not: call it with `async: true` and `timeout: 0`.

`landPr` returns a `watch` string that already uses this script's absolute real
path — run that string as given. For a standalone invocation, resolve the path
first so `$0` can find `../feature/workflow-readiness.js`:

```bash
T=$(realpath skill://ci-watch/ci-watch.sh) && bash "$T" <pr>
```

A pipe (`cat skill://… | bash -s`) or a copy of the script alone exits 70:
`ci-watch: run this script from its real path …`.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--timeout <n>s\|<n>m` | `30m` | Bounds the check phase and the merge phase together. Deadline → exit 5. |
| `--merge-mode merge-on-green\|native` | resolved by `readLanding` in `feature/workflow-readiness.js` (the resolver `landPr` uses): `landing.mode` on `origin/<base>`, else `merge-on-green` when that ref has `.github/workflows/merge-on-green.yml`, else `native`. `--base` (from `landPr`) or the PR's `baseRefName` names the ref. | merge-on-green watches the `reviewed` label. native watches `autoMergeRequest`. |
| `--since YYYY-MM-DDTHH:MM:SSZ` | none | GitHub's time of the `reviewed` label for this landing; `landPr` always passes it under merge-on-green. The evaluate-only probe judges only a `merge-on-green` run started at or after it (fractional `started_at` is truncated to the second before the compare). Without `--since` (standalone only), the probe judges the newest non-skipped run of any age. Missing value or another format → exit 70. |
| `--repo owner/repo` | `gh repo view` | Target repository. |
| `--interval <seconds>` | `15` | Poll interval. |

Checks watched: every run on the PR head, or exactly `landing.required_checks` when that list is declared. A commit status (`state`, no `conclusion`) is normalised first: `SUCCESS` passes, `PENDING` and `EXPECTED` stay pending, `FAILURE` and `ERROR` fail; a check run is left unchanged. `skipped` and `neutral` are passing either way — a declared required check with either conclusion does not stop the watch and does not block `GREEN`. GitHub counts both as passing for a required context. A green result waits one more poll so a late run is not missed.

`landing.required_checks` declares what this watch observes; it does not make
those names GitHub-required. The native landing guard uses nonempty declared
names without verifying their enforcement. Branch protection/rulesets must
actually enforce the intended checks on the selected base/head to support
landing's runtime-proof claim; without that enforcement, native merge can occur
before the declared checks finish. No enforcement policy is installed by this
watch, and `GREEN` alone is not proof that any named test ran.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Merged, or nothing to watch (native mode, no auto-merge). |
| 1 | A check failed. Failed-job logs are printed, and each failing check as `name=conclusion` on stderr. |
| 2 | Cancelled. Each cancelled check is printed as `name=conclusion` on stderr. |
| 3 | Another conclusion. Offending checks are printed on stderr as `name=conclusion`. Skipped and neutral are not this code, declared list or not. |
| 4 | Green but unmerged, or the PR closed during the check phase. Under merge-on-green, the `reviewed` label disappearing is this code. |
| 5 | Deadline. Undetermined — re-run to resume. A leading-zero timeout (`09`, `010`) is decimal seconds, not octal. |
| 6 | Evaluate-only (merge-on-green only). Once checks are green, every merge-phase poll that keeps watching looks at the newest non-skipped `merge-on-green` check run on the PR head started at or after `--since` (any age, without `--since`), until that run has completed. Completed with a `kit-ci not configured` or `Manual merge required` annotation: with `--since`, prints `evaluate-only: kit-ci App not configured — manual merge required (docs/kit/ci-app-setup.md)`; without `--since`, prints `evaluate-only: the latest merge-on-green run was evaluate-only — configure kit-ci (docs/kit/ci-app-setup.md), then re-label reviewed`. Completed without the annotation: configured, the probe stops. Maps to `evaluate-only`; `applyCiWatchExit` in `skills/feature/workflow-watch.js` retains the gate only while currently authorized. |
| 7 | Behind. The PR is OPEN and its `mergeStateStatus` is `BEHIND`: it cannot merge until the branch is updated, so it is never watched and never a deadline. Printed as `behind: PR <n> is behind its base and cannot merge — run: gh pr update-branch <n>` on stderr. It wins over exit 5 (also while checks are still pending), over the eligibility rules (an unarmed native PR, a revoked `reviewed` label) and over every check verdict; `MERGED` (0) and `CLOSED` (4) still come first. Maps to `behind`; `applyCiWatchExit` in `skills/feature/workflow-watch.js` clears a known arm, never retains it. |
| 70 | Not a check verdict: usage, unknown flag, a value flag without its value, bad mode or timeout, an invalid `landing` in `.dev/stack.yml` (invalid YAML, a mode other than native/merge-on-green, `required_checks` not a list of names), this script not run from its real path (cannot find `../feature/workflow-readiness.js`), missing `gh`/`jq`/`bun`, or a `gh`/`jq` failure. Maps to `watch-failed`; `applyCiWatchExit` in `skills/feature/workflow-watch.js` retains the gate only while currently authorized. Other non-table exits (124/137/143, …) also map to `watch-failed` under that policy. |

## Classifier

`ci-watch.sh --classify-merge-state STATE MSS MODE ELIGIBLE ELAPSED TIMEOUT` prints the exit code, or `WATCH` for a transient `BLOCKED` / `UNSTABLE` (a deadline past the timeout is 5). `BEHIND` is not transient: it is 7. No network.

Check runs are deduplicated per `(workflowName, name)` before classification: the newest entry wins, and an in-progress re-run outranks a completed stale one. That matches `gh pr checks` eliminating superseded runs so a leftover CANCELLED cannot disarm a PR whose latest run is green.
