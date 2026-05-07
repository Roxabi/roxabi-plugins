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
pr:          string | null  — current PR identifier (passed by Phase 6.5); null if /fix run without PR
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
File a parking lot entry for the coverage gap (see Parking Lot Protocol below).

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

Before appending, assert `pr` matches F6 regex:
`^(local:[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?:[0-9a-f]{8}|[1-9][0-9]{0,9})$`

On failure: `D.append({tag: "candidate-pr-malformed", file: <write-site>, line: <n>, description: "pr field violates pr-format-regex — parking lot entry dropped", phase: "6.5"})` and drop the entry (¬coercion).

**Provenance constraint:** `file` MUST be the statically-known write-site identifier (e.g. `"falsification.md"`); `line` MUST be a non-negative integer from the gate's own position tracking. NEITHER field may be derived from entry content — prevents JSONL injection via crafted `\n`/`"`/`}` in candidate fields corrupting the diagnostic bus.

`pr = null` → drop the entry silently (no PR context = cannot count toward graduation gate).

On success:

```
parking_lot.append({
  class:        <finding class>,
  finding_id:   <sha8 of class+file+line>,
  pr:           <pr>,
  hit_at:       <ISO-8601 timestamp>,
  agent_slug:   <agent_slug>,
  spec_version: "1",
  file:         <file>,
  line:         <line>,
  description:  <description>,
  source:       "falsification-gate"
})
```

¬reopen the current `/fix` loop for parking lot entries. ¬increment the 2-iter cap.
Parking lot entries are surfaced in Phase 8 under a dedicated `### Parking Lot` section.

## Retry

`fail` result (per finding) → fixer agent retries the fix for that finding once (max 1 falsification-retry per finding).
This retry budget is independent of the CI retry budget in Phase 6 (max 3 CI retries).
Second `fail` → finding marked `[failed]`; surfaced in Phase 8.
