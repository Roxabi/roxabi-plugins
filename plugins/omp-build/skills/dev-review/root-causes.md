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

## Evidence-v1 candidate

Read `skill://dev-review/evidence-policy.md` when evaluating the candidate. Baseline
remains authoritative in shadow. An active candidate follows only independently
accepted selected work; Phase 4 remains the sole source of qualification, final
labels, verdict and selected decision records.

For an active candidate, every selected cause carries `authorization: required` or
`authorization: optional-neighbor-of <causeId>` plus bounded admission evidence.
Exact `findingIds` are required. A missing/invalid authorization, admission, safe
boundary or membership authorizes no patch. A required member is an evidenced,
applicable mandatory obligation, not an inherited baseline label. An optional-only
set creates neither a plan nor a fix route. An optional neighbor records the six
evidence-policy conditions (current defect/mechanism, selected required boundary,
unchanged promise, no dependency, caller compatibility, targeted proof) and
separability. Shared class, file, callsite, wording or prior neighbor does not
inherit admission.

A `required` cause may bind both blocking and non-blocking findings when one
demonstrated mechanism and minimal shared-producer correction resolves every exact
member. Do not split it by label or call an ordinary shared mechanism an optional
neighbor. `optional-neighbor-of` is a distinct additional correction beside an
admitted required cause; it needs its own exact memberships, all six conditions and
separability, and never authorizes unrelated work.

## Who enters

actionable := {issue, suggestion, todo, nitpick}, including `(blocking)` and `(non-blocking)` forms.

praise, thought, question never enter a cause. They stay in the review.

## Join

Two actionable findings are the same cause only when the mechanism is the same. Read the cited lines before a join the text does not already make obvious.

Join when any holds:

- The root-cause sentences name one mechanism, and a fix of that mechanism removes both symptoms.
- One finding's mechanism is why the other exists.
- The cited lines show one missing source of truth, one wrong abstraction, or one missing guard producing every symptom.

Do not join on a shared file, a shared agent, a shared class slug, or similar symptom wording. Two `sql-injection` findings in unrelated queries are two causes.

An unusable finding (`dev-review` § Finding format) is never healed by a join: when cited, its cause is ineligible to apply and remains blocking when it is required. In baseline, each ineligible or failed blocking cause has its own debt issue while nonblocking obligations are bundled per run. In evidence-v1, an obligation requires independent `important AND urgent AND too-large` evidence before filing; otherwise its receipt/comment retains it. When not cited, it stays uncited.

## Record

One immutable `Cause` per mechanism, ordered with required/blocking causes first.
The model decision supplies:

```text
id, title, mechanism, fix, failure, restored, paths[], proof, findingIds[],
authorization?, admission?
```

The seven plan fields are `mechanism`, `fix`, `failure`, `restored`, `paths`,
`proof`, and `findingIds`. They are non-empty; paths are repository-local producer
and consumer entries. Cause `findingIds` resolve to final findings; those findings'
`sourceFindingIds` resolve to the retained originals. Unknown or duplicate
references refuse admission rather than causing reclustering. An unusable member
remains represented but cannot authorize application of its cause.

`fix` is the one plan: it changes the oracle or single source of truth across every
path and member callsite. Widening a denylist, adding a grep, or copying an inventory
is not a fix. An unplannable actionable finding remains retained; baseline preserves
the blocking disposition and evidence-v1 preserves required obligations unless the
separate debt rule admits a later issue.

## No planned correction

The canonical representation is `causes: []`, not a Markdown section to parse.
It means no correction plan was selected, not that the findings disappeared or
that the review is clean. Every final finding and original association remains;
final labels still determine the verdict.

An uncited actionable finding is not reclustered by `fix`. Baseline files each
uncited blocker and places nonblocking obligations in the single deferral bundle.
Evidence-v1 retains the obligation and permits an issue only with independently
supported `important AND urgent AND too-large` admission. Filing never clears a
blocker or grants application or landing.

## Proof

One rule, shared by the review that states `proof:`, the `fix` that runs it, and the falsification gate that tries to break it.

- A proof is an executable observation of consumer-visible behaviour, a boundary, a transition, or an error, and it exercises every `paths:` entry. Where the repository has what it needs, it runs as a test inside the repository, through the repository's own test command.
- It fails while the mechanism holds — on the `failure:` scenario — and passes once `restored:` holds.
- Not proof: an assertion on source or prose text, a check that one place copies another (a wiring copy), or a mock that echoes what the test fed it. A cause whose `proof:` is one of these is not eligible to apply.
- A cause whose mechanism is a missing or weak test is planned like any other: `failure:` is the unsafe behaviour the existing guard prevents, left unobserved when that guard breaks; `fix:` adds the test; `proof:` is that test. The falsification gate breaks the existing guard instead of one the commit introduced.
- `proof: NO TEST: <reason>` is legal only with a reason the review's NO TEST policy allows (`skill://dev-review/evidence-policy.md` § Baseline Phase 2 proof adjudication), plus the evidence that stands instead. It is an explicit skip: never recorded as a passing test, never reported as proven.
- A proof that needs infrastructure, a command or a service the repository does not have cannot run here. `fix` does not create it, and the falsification gate reports `skipped` with that reason.
- An accepted proof is a test in the diff that meets this rule for the behaviour, or, outside a safety invariant, a NO TEST row legal under that policy. Evidence that a test in the diff survives the removal of the guard it covers, or asserts nothing the behaviour decides, is evidence of a defect: that test is not accepted. A NO TEST row is a skip and never clears a gap on a safety invariant (`skill://dev-review/evidence-policy.md` § Baseline Phase 2 proof adjudication). A skip reported in a fix receipt is not an accepted proof. A later review does not demand an accepted proof again without new evidence of a defect (`skill://dev-review/evidence-policy.md` § Baseline Phase 4 classification).

The native applier reports proof implementation files separately as explicit
`proofPaths`. A missing-test correction may change those files without changing
the production paths whose existing guard the proof observes. These paths are
model-owned associations, checked against repository scope and actual Git effects;
the host does not discover them by parsing the declarative `proof` text or a shell
command.
