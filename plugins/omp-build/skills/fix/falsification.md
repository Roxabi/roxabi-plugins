# Falsification Gate

Gate definition for Phase 4 of `skill://fix`. Runs once per applied cause. It tries to break the
cause's own `proof:` under the one proof rule in `skill://dev-review/root-causes.md` § Proof.

This is a local procedure, not the executable falsify oracle cut by ADR-020 §8: no script runs,
no artifact is written, and nothing here feeds the review roster.

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

```
cause:     the applied cause (id, fix, failure, restored, paths, proof, commit sha)
```

## Procedure

1. `proof: NO TEST: <reason>` → `skipped`, note the reason. Nothing runs: a justified NO TEST is an explicit skip, not coverage.
2. The proof could not run in Phase 3 — it needs infrastructure, a command or a service the repository does not have → `skipped`, note what is missing. The receipt carries that reason; no parking-lot entry is added for it.
3. Otherwise, for each guard the cause's commit introduced — one per path when the fix guards each path, one when a single source guards every path. When the commit only adds the proof (a missing-test cause, root-causes.md § Proof), the guards are the existing production guards that proof observes:
   1. Identify the guard: the production condition, check or routing the commit added, or for a missing-test cause the existing one the proof observes. Never the proof's own test, assertion, fixture or setup. No guard identifiable → inconclusive.
   2. Temporarily remove it (do NOT commit).
   3. Re-run the proof through the repository's test command, scoped to the proof's test.
   4. Evaluate:
      - the proof's assertion fails on the `failure:` scenario, on the path that guard protects → that guard holds
      - the proof still passes → tautological → `fail`
      - the run errors (syntax, import, missing fixture) or fails on an assertion that does not observe the `failure:` scenario → inconclusive
   5. Restore the removed code.

Removing wording — a comment, a message no consumer reads, an identifier — is never a falsification
step. The proof must fail because the unsafe behaviour returned, not because text changed.

## Output

```
result:   "pass" | "fail" | "skipped"
cause:    string           — the cause id
notes:    string           — the skip or inconclusive reason; optional otherwise, ≤1 line
```

## Aggregation

```
cause_result = "fail"     if a guard removal left the proof passing
             = "skipped"  if the proof is NO TEST, could not run, no guard was identifiable, or a run was inconclusive
             = "pass"     only when at least one guard was removed and every removal made the proof fail on its `failure:` scenario
```

`skipped` is never a pass. Nothing counts it as one: not this aggregation, not Phase 4 of
`skill://fix`, not the receipt. Phase 4 in SKILL.md consumes `cause_result`. A cause whose own
proof passes is never re-applied because another cause shares a class.

## Parking Lot Protocol

Any new finding surfaced during falsification (same class or different class), including coverage gaps:

```
parking_lot.append({
  class:       <finding class>,
  file:        <file>,
  line:        <line>,
  description: <description>,
  source:      "falsification-gate"
})
```

¬reopen the current fix loop for parking lot entries. ¬increment the 2-iter cap.
Parking lot entries are surfaced in Phase 6 under a dedicated `### Parking Lot` section.

## Retry

`fail` → re-apply that cause once, inline, in the same session, as a new commit (max 1
falsification-retry per cause — there is no fixer agent to hand it to). The retry re-implements
the same `fix:` and `proof:`; it never adopts another plan or another proof.
This retry budget is independent of the CI retry budget in Phase 3 (max 3 CI retries).
Second `fail` → `git revert --no-edit` the cause's commits; cause marked `[failed]` and filed;
surfaced in Phase 6.
`skipped` → no retry. The commit stands and is reported as skipped, with its reason.
