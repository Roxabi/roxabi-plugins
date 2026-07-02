# Release Convention

Canonical org source: `~/projects/docs/release-convention.md` (Roxabi-wide — tag format, release-please invariants). This file is the in-plugin restatement of the two rules dev-core skills need at runtime: merge method + branch topology. Do not contradict the org source; if they drift, the org source wins.

Let: staging := default branch for dev-core-managed repos | main := promote-only, reached via `/promote`

## Merge method — merge commit only

PRs merge via **merge commit**, never squash or rebase-merge.

Why: squash rewrites file hashes on every merged commit, which phantom-conflicts every touched file on the next `/promote` (staging→main) — already bit `roxabi-plugins` once (46 phantom conflicts). Merge commits preserve the commit/tag topology `/promote` and `/release-setup` rely on, including the `<component>/vX.Y.Z` tag format.

## Branch topology

| Branch | Role |
|---|---|
| `staging` | Default branch. All feature/fix work targets this. |
| `main` | Promote-only. Reached exclusively via `/promote` (staging→main); never merge feature branches directly into `main`. |

## Consumers

Referenced by `/promote`, `/code-review` (merge gate), `/checkup` (`PR_Main` ruleset check). Enforce via the repo's branch-protection `allowed_merge_methods = ["merge"]` (see `checkup/cookbooks/devcore-checks.md`).
