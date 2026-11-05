# Root causes

The unit of a correction. A finding is a symptom. A root cause is the shared
mechanism behind one or more actionable findings, stated in one model-owned decision.
The record-native `fix` consumer applies only an admitted cause; it does not infer
identity, merge findings, select labels, repair memberships, or invent a plan.

The decision binds each final finding to its retained originals. Causes reference
exact **final finding IDs**, not original contribution IDs, source-finding IDs, or
copied descriptions. `dev-review` names them after synthesis; `fix` consumes the
decision by record reference, and `skill://fix/falsification.md` tries to break
each applied plan under § Proof.

## Partition and disposition

Every usable final finding belongs to exactly one cause; every unusable finding
belongs to one `unassignedFindings` entry with diagnostics. Each original is
retained exactly once. Merge originals only when their targets match; findings with
different targets may still share a cause when their mechanism is the same.

Each cause supplies cited judgments for necessary, urgent and too-large, and a
proposed disposition. Necessary and urgent work that fits is `fix-original`;
too-large blocking work is `sister-blocking`, and too-large nonblocking necessary
and urgent work is `sister-after`. Other nonblocking work is a report. Missing,
contested or contradictory blocking evidence stays pending for adjudication.
The engine validates these rules; a proposed disposition grants no authority.

## Join

Two actionable findings are the same cause only when the mechanism is the same. Read the cited lines before a join the text does not already make obvious.

Join when any holds:

- The root-cause sentences name one mechanism, and a fix of that mechanism removes both symptoms.
- One finding's mechanism is why the other exists.
- The cited lines show one missing source of truth, one wrong abstraction, or one missing guard producing every symptom.

Do not join on a shared file, a shared agent, a shared class slug, or similar symptom wording. Two `sql-injection` findings in unrelated queries are two causes.

An unusable finding is retained with its original label and target when known, and diagnostics; it is never healed by a join or used to authorize an apply.

## Record

One immutable `Cause` per mechanism. The model decision supplies:

```text
id, title, mechanism, fix, failure, restored, paths[], proof, findingIds[],
judgment, proposedDisposition
```

The seven plan fields are `mechanism`, `fix`, `failure`, `restored`, `paths`,
`proof`, and `findingIds`. They are non-empty; paths are repository-local producer
and consumer entries. Cause `findingIds` resolve to final findings; those findings'
`sourceFindingIds` resolve to the retained originals. Unknown or duplicate
references refuse admission rather than causing reclustering. An unusable finding
remains represented in `unassignedFindings`, not a runnable cause.

`fix` is the one plan: it changes the oracle or single source of truth across every
path and member callsite. Widening a denylist, adding a grep, or copying an inventory
is not a fix. An unplannable actionable finding remains retained, and a blocking
or indeterminate obligation stays pending until motivated adjudication.

## No planned correction

The canonical representation is `causes: []` only when no usable finding requires
a cause. It does not imply that retained findings disappeared or the review is
clean; final labels and independent criterion verdicts still govern review.

Every usable finding has exactly one cause. Retained findings and rule errors
receive named handling on the original UW; no grouped issue is filed automatically.
Neither a report nor an operator rejection grants criterion satisfaction or landing.

## Proof

One rule, shared by the review that states `proof:`, the `fix` that runs it, and the falsification gate that tries to break it.

- A proof is an executable observation of consumer-visible behaviour, a boundary, a transition, or an error, and it exercises every `paths:` entry. Where the repository has what it needs, it runs as a test inside the repository, through the repository's own test command.
- It fails while the mechanism holds — on the `failure:` scenario — and passes once `restored:` holds.
- Not proof: an assertion on source or prose text, a check that one place copies another (a wiring copy), or a mock that echoes what the test fed it. A cause whose `proof:` is one of these is not eligible to apply.
- A cause whose mechanism is a missing or weak test is planned like any other: `failure:` is the unsafe behaviour the existing guard prevents, left unobserved when that guard breaks; `fix:` adds the test; `proof:` is that test. The falsification gate breaks the existing guard instead of one the commit introduced.
- `proof: NO TEST: <reason>` is legal only with a reason the review policy allows (`skill://dev-review/evidence-policy.md` § Baseline Phase 2 proof adjudication), plus the evidence that stands instead. It is an explicit skip: never recorded as a passing test, never reported as proven.
- A proof that needs infrastructure, a command or a service the repository does not have cannot run here. `fix` does not create it, and the falsification gate reports `skipped` with that reason.
- An accepted proof is a test in the diff that meets this rule for the behaviour or, outside a safety invariant, an allowed `NO TEST` state under that policy. Evidence that a test in the diff survives removal of the guard it covers, or asserts nothing the behaviour decides, is evidence of a defect: that test is not accepted. An allowed skip never clears a gap on a safety invariant. A skip reported in a fix receipt is not an accepted proof. A later review does not demand an accepted proof again without new evidence of a defect (`skill://dev-review/evidence-policy.md` § Baseline Phase 4 classification).

The native applier reports proof implementation files separately as explicit
`proofPaths`. A missing-test correction may change those files without changing
the production paths whose existing guard the proof observes. These paths are
model-owned associations, checked against repository scope and actual Git effects;
the host does not discover them by parsing the declarative `proof` text or a shell
command.
