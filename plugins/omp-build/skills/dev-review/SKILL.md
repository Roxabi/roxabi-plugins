---
name: dev-review
argument-hint: '[#PR]'
description: Independent review of an open PR head — reviewer agents, findings on the PR, verdict line when approved.
version: 0.4.6
---

# Dev review

Review the current head of one open pull request with agents other than its author. Leave the findings on the PR and, when the head is approved, post the head-bound verdict. `/dev-review` never edits code, pushes or merges.

## 1. Bind the PR

1. Target: the `#PR` argument, else the open PR of the current branch: `gh pr view [<PR>] --json number,state,url,headRefOid,baseRefName,body`.
2. No open PR → stop and say so: `/dev-review` runs only on an existing PR. A PR whose base is not the repository's default branch (`gh repo view --json defaultBranchRef`) is not reviewed yet: a stacked PR is reviewed once it targets the default branch.
3. Record `HEAD` = `headRefOid` (40 hex) and `BASE` = `baseRefName`. The review covers that commit only.
4. Fetch from the PR's own repository (its URL without `/pull/<PR>`), not `origin`, which may be a fork:
   - `git fetch <repo> refs/heads/<BASE>`, then `BASE_SHA=$(git rev-parse FETCH_HEAD)`;
   - `git fetch <repo> refs/pull/<PR>/head`; `git rev-parse FETCH_HEAD` must equal `HEAD`, else stop.
   The change is `git diff <BASE_SHA>...<HEAD>`.
5. Check out the reviewed tree apart from the current one, without running its hooks: `git -c core.hooksPath=/dev/null worktree add --detach <dir> <HEAD>`. Every source read of the review happens there. Remove it on every exit, a stop included: `git worktree remove --force <dir>`.
6. **Composed:** review only the host's `## Accepted Spec` snapshot for the bound issue, including inherited clauses and their source refs. Record its `spec: <digest>` value (64 lowercase hex); if the section or digest is missing or invalid, stop. If you discover a newer accepted own or inherited Spec, stop without publishing review evidence or a verdict: report the accepted change and ask the operator to rerun `/feature` for a new snapshot. A live body edit alone is not evidence of acceptance. Compare `acceptedBodySha256` with the live body hash (`(set -o pipefail; gh api repos/<owner>/<repo>/issues/<N> | jq -erj '.body | strings' | sha256sum)`). Report a mismatch or an unavailable comparison; neither changes the review scope. **Standalone:** read the unambiguous linked issue from the PR body (`Closes #N`, `References #N`, or a `UW #N` line) and use its criteria. The PR body is not proof of binding.

## 2. Pick the reviewers

- Choose independent, read-only reviewers from the agents available to the session. The session that wrote the change does not review it.
- Cover adversarial review, including OWASP (e.g. `R-adversarial`). Choose specialists where the diff warrants them: architecture and data flow, security and permissions, test evidence, or CI and configuration.
- Spawn them in one `task` batch. Give each: repository, PR number, `HEAD`, the review worktree path (read sources only there), the diff command, the requirements from step 1.6, and the checklists in this skill directory (`evidence-policy.md`, `review-blind-spots.md`, `review-smells.md`). Give `R-adversarial` the actual `Spawned roster:` if selected. Ask for factual findings only: `file:line`, blocking or non-blocking, the evidence, no fixes.

## 3. Consolidate

- Every selected reviewer must return a completed result. Rerun a reviewer that failed, was cancelled or returned nothing; without its result there is no approval.
- Merge duplicates. Check each blocking finding in the review worktree. Only the reviewer that raised a blocker drops it: when the code at `HEAD` seems to refute it, send that evidence to that reviewer; the blocker stays unless it withdraws it.
- Verdict: **approve** when every reviewer completed and no blocking finding remains, else **request changes**.

## 4. Publish on the PR

1. Re-read the PR. If its head is no longer `HEAD` or its base is no longer `BASE`, stop: the review is stale; run `/dev-review` again.
2. Post one comment (`gh pr comment <PR> --body-file <file>`). First line: `## Review — head <HEAD> base <BASE> spec <digest>` in composed mode, copying the digest from step 1.6; `## Review — head <HEAD> base <BASE>` standalone. Then list the reviewers and findings (blocking first) with `file:line`. The last line is exactly `Verdict: approve` or `Verdict: request changes`. `/dev-fix` reads this format. Keep it public-safe: no secrets, private paths, raw logs or client data.
3. On approve, post a second comment whose only line is:

   ```text
   review-verdict v1 head=<HEAD> approve evidence=<URL of the review comment>
   ```

   The Review Verdict workflow turns it into the `review` check that the `PR_Main` ruleset requires next to `ci` (CONTRIBUTING.md § PR conventions). The account posting it needs write access. A new commit needs a new review and a new verdict.
4. On request changes, post no verdict line. The next step is `/dev-fix` on this PR.

## 5. Report

Remove the review worktree. Report one line: PR, `HEAD`, verdict, comment URLs.
