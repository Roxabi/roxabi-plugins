---
name: dev-review
argument-hint: '[#PR]'
description: Independent review of an open PR head — reviewer agents, findings on the PR, verdict line when approved.
version: 0.4.0
---

# Dev review

Review the current head of one open pull request with agents other than its author. Leave the findings on the PR and, when the head is approved, post the head-bound verdict. `/dev-review` never edits code, pushes or merges.

## 1. Bind the PR

1. Target: the `#PR` argument, else the open PR of the current branch: `gh pr view [<PR>] --json number,state,url,headRefOid,baseRefName,body`.
2. No open PR → stop and say so: `/dev-review` runs only on an existing PR.
3. Record `HEAD` = `headRefOid` (40 hex). The review covers that commit only.
4. `git fetch origin <base> <HEAD>`; the change is `git diff origin/<base>...<HEAD>`.
5. Read the linked issue (`Closes #N` / `References #N` in the PR body): its criteria are what the change must meet.

## 2. Pick the reviewers

- Always `R-adversarial`. It also covers the OWASP lens.
- Add from the diff:
  - `R-architect`: new interfaces, cross-module or data-flow changes;
  - `R-security-auditor`: auth, secrets, tokens, crypto, permissions, CI credentials;
  - `R-tester`: test changes, or behavior changed without a test;
  - `R-devops`: CI workflows, dependencies, build, configuration.
- Reviewers are separate read-only agents. The session that wrote the change does not review it.
- Spawn them in one `task` batch. Give each: repository, PR number, `HEAD`, base, the diff command, the issue criteria, and the checklists in this skill directory (`evidence-policy.md`, `review-blind-spots.md`, `review-smells.md`). Ask for factual findings only: `file:line`, blocking or non-blocking, the evidence, no fixes.

## 3. Consolidate

- Merge duplicates. Check each blocking finding against the code; drop one the code refutes and say why.
- Verdict: **approve** when no blocking finding remains, else **request changes**.

## 4. Publish on the PR

1. Re-read the PR head. If it is no longer `HEAD`, stop: the review is stale; run `/dev-review` again.
2. Post one comment (`gh pr comment <PR> --body-file <file>`): `## Review — head <HEAD>`, the reviewers used, the findings (blocking first) with `file:line`, then the verdict. Keep it public-safe: no secrets, private paths, raw logs or client data.
3. On approve, post a second comment whose only line is:

   ```text
   review-verdict v1 head=<HEAD> approve evidence=<URL of the review comment>
   ```

   The Review Verdict workflow turns it into the `review` check that the `PR_Main` ruleset requires next to `ci` (CONTRIBUTING.md § PR conventions). The account posting it needs write access. A new commit needs a new review and a new verdict.
4. On request changes, post no verdict line. The next step is `/dev-fix` on this PR.

## 5. Report

One line: PR, `HEAD`, verdict, comment URLs.
