---
name: dev-fix
argument-hint: '[#PR] [scope]'
description: Fix the findings of the latest /dev-review on an open PR head, push the exact tip, then review again.
version: 0.1.0
---

# Dev fix

Correct the findings that `/dev-review` left on one open pull request, on that PR's branch. `/dev-fix` never reviews its own work, posts a verdict or merges: the next step is always `/dev-review` on the new head.

## 1. Preconditions

1. Target: the `#PR` argument, else the open PR of the current branch: `gh pr view [<PR>] --json number,state,url,headRefOid,headRefName,isCrossRepository,comments`.
2. No open PR → stop: `/dev-fix` runs only on an existing PR with a finished implementation. A PR from a fork (`isCrossRepository`) → stop: its branch is not pushed from here.
3. Record `HEAD` = `headRefOid`. The review is the latest PR comment that starts with `## Review — head `:
   - none → stop: run `/dev-review` first;
   - its head is not `HEAD` → stop: the review is stale; run `/dev-review` again;
   - its verdict is approve and the operator gave no scope → stop: nothing to fix.
4. Work in a checkout of the PR branch whose `HEAD` is that commit and whose tree is clean. `omp_build_prepare_checkout` with the PR number gives the canonical one. Not clean or not at `HEAD` → stop.

## 2. Plan

- Fix every blocking finding. Fix a non-blocking one only if the operator's scope asks for it or it is a one-line correction in a file already changed.
- Group findings that share a cause; one cause, one change.
- A finding judged wrong is not fixed silently: it goes to the report with the code evidence that refutes it.
- Work outside the PR's linked issue is not done here: name it in the report.

## 3. Fix

- Spawn implementer agents in one `task` batch, one per independent cause, with disjoint files. Give each: the finding with its `file:line` and evidence, the files it owns, and the check that proves the fix. Agents edit and run their check; they do not commit or push.
- A behavior fix comes with a test that fails before it and passes after. Falsify it: temporarily remove the guard the fix added and re-run the test; it must fail on the reported scenario. A test that still passes proves nothing: rework the fix. Restore the guard.
- Run the repository's checks for the changed files (`.dev/stack.yml` names them), then the checks the review flagged.

## 4. Publish

1. Commit with a message that names the findings fixed.
2. Re-read the PR: its head must still be `HEAD`, else stop and say so.
3. Push the exact tip, never `HEAD:` and never with force: `git push origin <tip>^{commit}:refs/heads/<headRefName>`. Then `gh pr view <PR> --json headRefOid` must equal the tip.
4. Post one comment: `## Fixes — head <tip>`, then for each finding: fixed (commit, check) or not fixed (reason). Keep it public-safe: no secrets, private paths, raw logs or client data.

## 5. Report

One line: PR, new head, findings fixed / not fixed, comment URL. Next: `/dev-review` on the new head; a new head needs a new review and a new verdict.
