# Falsification Gate

Gate definition for Phase 6.5 of `/fix`. Runs once per class after fixes are applied.

## Purpose

Detect tautological fixes (RC-1): a fix that makes a test pass without actually enforcing the
invariant. Method: delete the guard or test setup introduced by the fix, then re-run the test.
If the test still passes → tautological.

## Input

```
class:       string         — the class being verified (e.g. "test-tautology")
findings:    finding[]      — findings of this class that were fixed in Phase 6
agent_slug:  string         — slug of the fixer agent that applied the changes
```

## Procedure

For each fixed finding in the class:

1. Identify the guard or setup introduced by the fix (new assertion, new mock setup, new condition).
2. Temporarily remove it (do NOT commit).
3. Run the test suite scoped to the changed files.
4. Evaluate:
   - Test **fails** → fix is genuine → `pass`
   - Test **passes** → fix is tautological → `fail`
5. Restore the removed code.

If no test covers the fixed line (no test to falsify) → emit `pass` with note:
`"no covering test — falsification skipped; coverage gap logged as parking lot finding."`
File a parking lot entry: `{ class: "missing-test-coverage", file: <file>, line: <line> }`.

## Output

```
result:   "pass" | "fail"
class:    string
notes:    string           — optional, ≤1 line
```

## Parking Lot Protocol

Any new finding surfaced during falsification (same class or different class):

```
parking_lot.append({
  class:       <finding class>,
  file:        <file>,
  line:        <line>,
  description: <description>,
  source:      "falsification-gate",
  pr:          <current PR number>
})
```

¬reopen the current `/fix` loop for parking lot entries. ¬increment the 3-iter cap.
Parking lot entries are surfaced in Phase 8 under a dedicated `### Parking Lot` section.

## Retry

`fail` result → fixer agent retries the fix for that finding once (max 1 retry per finding).
Second `fail` → finding marked `[failed]`; surfaced in Phase 8.
