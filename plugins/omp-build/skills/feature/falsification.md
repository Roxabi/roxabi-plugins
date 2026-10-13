# Falsification

Run once by `skill://feature` §6.7 when `step.action === 'land'`, before `landPr`, over
all causes this PR applied in its fix rounds, against the head that would land. This is a
local procedure, not ADR-020 §8's executable falsify oracle: no script or artifact, and
nothing here is read by `landPr`, admission or the roster. It commits and pushes nothing.

## Purpose

Detect a fix that makes the proof pass without enforcing the restored behaviour. Method: remove
the production guard the fix introduced — or, for a missing-test cause, the existing guard its
test observes — re-run the cause's proof, and require it to fail on the cause's `failure:`
scenario. If the proof still passes → tautological. If it cannot run, or fails for another
reason, nothing was shown: that is `skipped`, never `pass`.

A "fix" that only widens a denylist, adds a grep, or copies an inventory list is itself
tautological — `fail`, whatever the members' classes. The oracle or single SSoT (matcher,
parser, one `package.json` script) must change.

## Input

Use `readComments(cwd, pr)` for the automation login and every comment in creation order.
Select that login's `## Review Fixes Applied` receipts, each paired with its latest preceding
same-login marked review. A receipt after an approval, or with no preceding review, is not a
review-fix input. Every `### Applied` line supplies RC id and sha; the paired record's matching
RC block supplies `failure:`, `restored:`, `paths:` and `proof:`. Identify a cause by record +
RC + sha, never its round-local RC alone.

Read the approved head's first-parent history successfully before classifying shas. A valid
full or abbreviated hexadecimal sha must match it uniquely; positive absence is `skipped (not
in head)`. Malformed or ambiguous sha, or a history/read/record/block error, stops
`proof-blocked` with that actual error — never zero causes. A resolved commit whose successfully
read first-parent diff touches no block `paths:` is likewise `skipped (not in head)`. Strip path
line suffixes and resolve named entry points to files; an unresolved mapping is a read error,
not an empty intersection. With no causes, print `Falsification: none` and post nothing.

## Worktree

Before every pass Git operation and install/proof subprocess, clear inherited Git repository,
index and worktree redirections as `workflow.js` `gitResult` does. Make a fresh `mktemp -d`
outside the delivery checkout, add a detached checkout at the approved head with
`-c core.hooksPath=/dev/null -c core.fsmonitor=false`, then prepare it with `commands.install`
from `origin/<base>:.dev/stack.yml`. Preparation failure yields `skipped (inconclusive)` for
every cause. Guard edits and restores happen only in this disposable checkout: delivery files,
index, branches and remote remain untouched.

On every exit, independently attempt `worktree remove --force`, delete the owned temporary
directory, then prune. Preserve and report cleanup errors; never claim cleanup succeeded when
it did not.

## Procedure

1. `proof: NO TEST: <reason>` → `skipped`; note the reason. Nothing runs: a justified NO TEST
   is an explicit skip, not coverage.
2. A proof needing infrastructure, a command or service the repository lacks cannot run here →
   `skipped`; report why in the Falsification comment.
3. Otherwise, for every guard the cause's commit introduced — one per guarded path, or one
   single source guarding all paths. For a missing-test cause, use the existing production guard
   its proof observes:
   1. Identify that production condition, check or routing; never the proof's test, assertion,
      fixture or setup. No identifiable guard → `skipped (inconclusive)`.
   2. Remove it temporarily, without committing, in the disposable worktree.
   3. Re-run the proof through the repository test command, scoped to the proof's test.
   4. The proof assertion failing on its `failure:` scenario and protected path means the guard
      holds; a passing proof is `fail`; a syntax/import/missing-fixture error or another
      assertion failing is `skipped (inconclusive)`.
   5. Restore that guard in the disposable worktree before another guard.

Removing wording — a comment, message no consumer reads, or identifier — is never a
falsification step. The proof must fail because unsafe behaviour returned, not because text
changed.

## Comment

For one or more causes, write the body with the write tool in a `mktemp` directory and post it
with `gh pr comment --body-file`; do not edit the PR body. Its first line is exactly
`## Falsification`, with no `<!-- omp-build:… -->` line: review-bound and admission readers
select by first line.

```markdown
## Falsification

**Head:** `<sha>`
Falsification: P pass · S skipped · F fail — a skip is not a pass
- <record URL> — RC-n — `<sha>` — <result> — <reason>

### Observations
- <defect noticed during the pass; nothing is filed or fixed>
```

## Aggregation

```
cause_result = "fail"     if a guard removal left the proof passing
             = "skipped"  if the proof is NO TEST, cannot run, no guard is identifiable, or a run is inconclusive
             = "pass"     only when at least one guard was removed and every removal made the proof fail on its `failure:` scenario
```

`skipped` is never a pass. §6.7 consumes `cause_result` and the Falsification comment reports
it; another cause's class never re-applies this cause.
