# Falsification Gate

Gate definition for Phase 4 of `skill://fix`. Runs once per applied cause that has at least one classed member.

This is a local procedure, not the executable falsify oracle cut by ADR-020 §8: no script runs,
no artifact is written, and nothing here feeds the review roster.

## Purpose

Detect tautological fixes: a fix that makes a test pass without actually enforcing the
invariant. Method: delete the guard or test setup introduced by the fix, then re-run the test.
If the test still passes → tautological.

A "fix" that only widens a denylist, adds a grep, or copies an inventory list is itself
tautological — `fail`, whatever the members' classes. The oracle or single SSoT (matcher,
parser, one `package.json` script) must change.

## Input

```
cause:     the applied cause (id, fix line, commit sha)
findings:  finding[] — its member findings
```

## Procedure

For each member finding of the cause:

1. Identify the guard or setup the cause's commit introduced for it (new assertion, new mock setup, new condition).
2. Temporarily remove it (do NOT commit).
3. Run the test suite scoped to the changed files.
4. Evaluate:
   - Test **fails** → fix is genuine → `pass`
   - Test **passes** → fix is tautological → `fail`
5. Restore the removed code.

If no test covers the fixed line (no test to falsify) → emit `pass` with note:
`"no covering test — falsification skipped; coverage gap noted as parking lot finding."`
Record a parking lot entry for the coverage gap (see Parking Lot Protocol below).

## Output

```
result:   "pass" | "fail"
cause:    string           — the cause id
notes:    string           — optional, ≤1 line
```

## Aggregation

```
cause_result = "fail"  if ∃ member finding where per-finding result = "fail"
             = "pass"  otherwise (coverage gaps count as per-finding "pass")
```

Phase 4 in SKILL.md consumes `cause_result`. A cause whose own members pass is never re-applied because another cause shares a class.

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
falsification-retry per cause — there is no fixer agent to hand it to).
This retry budget is independent of the CI retry budget in Phase 3 (max 3 CI retries).
Second `fail` → `git revert --no-edit` the cause's commits; cause marked `[failed]` and filed;
surfaced in Phase 6.
