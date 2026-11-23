---
name: dev-fix
argument-hint: '[#PR] [scope]'
description: Fix the latest /dev-review findings and failing checks on an open PR head, push the exact tip, then review again.
version: 0.1.1
---

# Dev fix

Correct the findings that `/dev-review` left on one open pull request, and its failing checks, on that PR's branch. `/dev-fix` never reviews its own work, posts a verdict or merges: the next step is always `/dev-review` on the new head. Run standalone, it is authorized by the operator who runs it; it pushes only the exact tip.

## 1. Preconditions

When a `## Feature context` is present, use composed mode: take the repository and PR from the parent workflow, scope all `gh pr` and `gh repo` calls to that repository, and verify branch/base and worktree against the context. Missing or inconsistent coordinates stop composed mode. Otherwise use standalone mode.

1. Target: the `#PR` argument, else the open PR of the current branch: `gh pr view [<PR>] --json number,state,url,headRefOid,headRefName,baseRefName,isCrossRepository`. `<host>/<owner>/<repo>` comes from its URL.
2. No open PR → stop: `/dev-fix` runs only on an existing PR with a finished implementation. A PR from a fork (`isCrossRepository`) → stop: its branch is not pushed from here. A PR whose base is not the repository's default branch (`gh repo view --json defaultBranchRef`) → stop, as `/dev-review` does.
3. Record `HEAD` = `headRefOid` and `BASE` = `baseRefName`. The review is the latest PR comment (`gh api repos/<owner>/<repo>/issues/<PR>/comments --paginate`) whose author has write access (`gh api repos/<owner>/<repo>/collaborators/<login>/permission`: `admin`, `maintain` or `write`), whose first line is `## Review — head <sha> base <branch>` and whose last line is `Verdict: approve` or `Verdict: request changes`. Other comments are not reviews. Record its `id` and `updated_at` as `REVIEW`.
   - none → stop: run `/dev-review` first;
   - its head is not `HEAD` or its base is not `BASE` → stop: the review is stale; run `/dev-review` again.
4. The work is the review's findings plus every failing check on `HEAD` (`gh pr checks <PR>`; read a failure with `gh run view <run> --log-failed`). `Verdict: approve`, no failing check and no operator scope → stop: nothing to fix.
5. Work in a clean checkout of the PR branch at `HEAD`. Use the named feature worktree in composed mode; in standalone mode, `omp_build_prepare_checkout` with the PR number gives the canonical checkout. Not clean or not at `HEAD` → stop.
6. `git remote get-url --push --all origin` must list exactly one URL, naming `<host>/<owner>/<repo>`; else stop. Record it as `PUSH_URL`.

## 2. Plan

- Fix every blocking finding and every failing check. Fix a non-blocking finding only if the operator's scope asks for it or it is a one-line correction in a file already changed.
- Group findings that share a cause; one cause, one change.
- A finding judged wrong is not fixed silently: it goes to the report with the code evidence that refutes it.
- Work outside the PR's linked issue is not done here: name it in the report.

## 3. Fix

- Spawn implementer agents in one `task` batch, one per independent cause, with disjoint files. Give each: the finding with its `file:line` and evidence, the files it owns, and the check that proves the fix. Agents edit and run their check; they do not commit or push.
- A behavior fix comes with a test that fails before it and passes after. Falsify it: temporarily remove the guard the fix added and re-run the test; it must fail on the reported scenario. A test that still passes proves nothing: rework the fix. Restore the guard.
- Run the repository's checks for the changed files (`.dev/stack.yml` names them), then the checks the review flagged.

## 4. Publish

1. Commit with a message that names the findings fixed.
2. Re-read the PR: still open, head still `HEAD`, base still `BASE`, and the latest review comment by a writer still `REVIEW` with the same `updated_at` (an edited review is a new review). Anything else → stop and say so.
3. `git merge-base --is-ancestor <HEAD> <tip>` must hold, and `git remote get-url --push --all origin` must still list exactly `PUSH_URL`.
   - **Composed:** from the feature worktree, with `FEATURE_SKILL_DIR` set to the installed feature skill directory, run `bash "$FEATURE_SKILL_DIR/trusted-bun.sh" "$FEATURE_SKILL_DIR/feature-cli.ts" push --repo <owner/repo> --issue <N> --mandate <recordId> --tip <tip> --from <HEAD> --pr <PR>`. A refusal or uncertain result stops; never fall back to a standalone push.
   - **Standalone:** push the exact tip through `origin`, never `HEAD:`, never tags, and only over `HEAD`: `git push --no-follow-tags --force-with-lease=refs/heads/<headRefName>:<HEAD> origin <tip>^{commit}:refs/heads/<headRefName>`. The lease rejects a moved or deleted branch.
   - In both modes, `gh pr view <PR> --json headRefOid` must equal the tip before reporting.
4. Post one comment: `## Fixes — head <tip>`, the review it answers (`REVIEW`), then for each finding and failing check: fixed (commit, check) or not fixed (reason). Keep it public-safe: no secrets, private paths, raw logs or client data.

## 5. Report

One line: PR, new head, findings fixed / not fixed, comment URL. Next: `/dev-review` on the new head; a new head needs a new review and a new verdict.
