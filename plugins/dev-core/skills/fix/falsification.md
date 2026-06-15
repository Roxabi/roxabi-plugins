# Falsification Gate

Gate definition for Phase 6.5 of `/fix`. Runs once per class after fixes are applied.

## Purpose

Detect tautological fixes (RC-1): a fix that makes a test pass without actually enforcing the
invariant. Method: delete the guard or test setup introduced by the fix, then re-run the test.
If the test still passes → tautological.

## Input

```
class:     string    — the class being verified (e.g. "test-tautology")
findings:  finding[] — findings of this class that were fixed in Phase 6
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
`"no covering test — falsification skipped; coverage gap noted as parking lot finding."`
Record a parking lot entry for the coverage gap (see Parking Lot Protocol below).

## Output

```
result:   "pass" | "fail"
class:    string
notes:    string           — optional, ≤1 line
```

## Aggregation

The gate is invoked once per class and iterates over findings. Class-level result:

```
class_result = "fail"  if ∃ finding in class where per-finding result = "fail"
             = "pass"  otherwise (coverage gaps count as per-finding "pass")
```

Phase 6.5 in SKILL.md consumes `class_result` (boolean per class). Per-finding results feed the Retry section below.

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

¬reopen the current `/fix` loop for parking lot entries. ¬increment the 2-iter cap.
Parking lot entries are surfaced in Phase 8 under a dedicated `### Parking Lot` section.

## Retry

`fail` result (per finding) → fixer agent retries the fix for that finding once (max 1 falsification-retry per finding).
This retry budget is independent of the CI retry budget in Phase 6 (max 3 CI retries).
Second `fail` → finding marked `[failed]`; surfaced in Phase 8.
