# Falsification Gate

Gate definition for the correction-purpose `fix` workflow. It runs once per applied
cause and emits a durable `falsification-result` linked to its
`correction-result`. It evaluates the cause's own `proof:` under the one proof rule
in `skill://dev-review/root-causes.md` § Proof.

The production executor performs the temporary guard removal and records native/test
output facts. This document does not define a second parser, writer, roster input or
falsify runner.

## Purpose

Detect a fix that makes the proof pass without enforcing the restored behaviour. Method: remove
the production guard the fix introduced — or, for a missing-test cause, the existing guard its
test observes — re-run the cause's proof, and require it to fail on the cause's `failure:`
scenario. If the proof still passes → tautological. If it cannot run, or fails for another
reason, nothing was shown: that is `skipped`, never `pass`.

A "fix" that only widens a denylist, adds a grep, or copies an inventory list is itself
tautological — `fail`, whatever the members' classes. The oracle or single SSoT (matcher,
parser, one `package.json` script) must change.

## Evidence-v1 candidate

Read `skill://dev-review/evidence-policy.md` with this gate. Baseline retry behavior
below remains authoritative by default. An active evidence-v1 candidate reaches this
gate only from a required plan selected in its independently accepted, normal
authoritative Phase 4 review record; shadow never runs a patch or changes the baseline
result.

Falsification runs only for causes admitted as `fix-original` by the mechanical D14
assessment and the existing correction authority gates. Findings not selected for this
correction remain durable original-UW dispositions: `sister-after`, `sister-blocking`,
`report`, or `pending-blocking` as assessed. Preserve every finding and rule error with
its source. `pending-blocking` and unresolved `sister-blocking` hold continuation; a
sister or report is never dispatched as a correction.

This gate does not create issues. Sister creation and report promotion are explicit
operator operations with exact confirmation and confirmed readback on the original UW.
The accepted review policy does not authorize an additional optional-neighbor path.

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

The durable record retains `correctionResultId`, `result`, one-line `notes`, and raw
execution facts. A result is never derived from model prose:

```
result:   "pass" | "fail" | "skipped"
cause:    string           — the cause id
notes:    string           — the skip or inconclusive reason; optional otherwise, ≤1 line
raw:      guard removals, proof executions and observed failure scenario
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

## New findings

Retain each new finding or rule error, including coverage gaps, with its source and
diagnostics through the correction workflow's original-UW disposition records. A
finding requiring further classification remains pending and blocks continuation.
Use the explicit operator operations for a sister or promotion; never infer that an
issue was filed from a comment or an unconfirmed request.

## Retry

For an admitted `fix-original` cause, `fail` → revert the failed round and dispatch
one new native apply/falsify round for the same `fix:` and `proof:`. This is at most
one falsification retry per cause. Apply attempts remain bounded to three per round;
the independent Phase 3 CI retry budget remains at most three. A second `fail` → revert the failed correction commits and
retain the failed outcome and original-UW obligation. Do not claim an issue was filed:
only an explicit operator operation with confirmed readback can establish that effect.

`skipped` → no falsification retry. The commit stands and the skipped result and reason
remain in its durable correction/falsification records.
