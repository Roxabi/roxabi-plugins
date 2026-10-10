# Root causes

The unit of a fix. A finding is a symptom. A root cause is the shared mechanism behind one or more actionable findings, stated with its one plan. `dev-review` names them after dedup, before it posts. `fix` applies the plan of each well-formed cause that contains a blocking finding. A block missing any of its seven lines (§ Record) is malformed and is not applied, even when it contains a blocking finding. A well-formed cause with no blocking member is deferred, not applied. The plan is the decision: findings carry no solutions, so there is nothing else to pick from.

Three readers: `dev-review` Phase 4 writes the section, `fix` Phase 2 reads it, and `skill://fix/falsification.md` tries to break each applied plan under § Proof. `dev-review` and `fix` reach this file as `skill://dev-review/root-causes.md`.

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

A finding with no usable root-cause sentence is its own cause until the cited lines show it shares a mechanism with another. Still unnamed after that read: its own cause. An unusable finding (`dev-review` § Finding format) is never healed by a join: when it is cited, its cause is ineligible to apply and `fix` files it; when it is not, it stays uncited.

## Record

One block per cause. Order: a cause that contains a blocker first, then by the highest existence confidence among its members; a member with no confidence counts as the lowest. Every line is non-CC-shaped, per `dev-review/SKILL.md` Phase 4 § `/fix` partition.

The section ends at the next `##` heading. In a review, that heading is `## Findings`.

```markdown
## Root causes

### RC-1 — <one-line cause>
- mechanism: <why, not the symptom>
- fix: <the one change that closes the mechanism on every path below>
- failure: <the falsifiable scenario: the input or state, and the wrong observable outcome it produces today>
- restored: <the behaviour that holds once the mechanism is gone>
- paths: <every producer and consumer path that must show it, covering every member callsite: `path:line` or a named entry point ; …>
- proof: <the executable observation, per § Proof>   (or: NO TEST: <reason> — <the evidence that stands instead>)
- findings: `path:line` — <exact final rendered description> ; `path:line` — <exact final rendered description>

## Findings
```

A block is well-formed only when all seven lines are present and non-empty; a block that is not is malformed. A well-formed block is applied only when its `proof:` line also satisfies § Proof; otherwise `fix` files it as a cause, with its seven lines. The plan is stated before any edit: in the posted record, or — only when the record has no cause section — in the plan `fix` prints before its first edit. `fix` never adds a line to a posted block.

Finalize finding descriptions before building these references. Distinct findings at the same anchor have distinct mechanism-specific descriptions, with their original symptoms/evidence retained. Each `path:line` + exact description pair must resolve to exactly one finding under `## Findings`; each actionable finding belongs to at most one cause. A shared anchor never includes other findings implicitly. Zero/multiple matches or conflicting memberships do not authorize applying affected causes: keep findings for the existing uncited/per-finding filing/single-deferral paths, without reclustering the posted record.

`fix:` is the one plan: the change the mechanism requires, covering every `paths:` entry and every member callsite. It is not chosen from the members — findings carry no solutions. A fix line that only widens a denylist, adds a grep, or copies an inventory list is not a fix, whatever the members' classes. Name the oracle or single source of truth that must change.

An actionable finding the review cannot plan — no single safe change, or no proof § Proof admits — stays out of this section, uncited. It is never dropped: `fix` files it when it satisfies `blocks(f)`, and it keeps blocking; otherwise it joins the single non-blocking deferral.

Number `RC-1` upward. Do not reuse a number.

## `none`

No named cause → the section body is exactly `none`:

```markdown
## Root causes

none

## Findings
```

`none` is a complete record only when no actionable finding remains under `## Findings`. With an actionable finding there, the record is malformed: it carries no plan for that finding. That is a property of the record, not an accusation that the writer erred — a review that could plan nothing still renders `none`, and its Summary says `no cause planned for N actionable finding(s)`. `fix` treats each such finding as uncited: each blocker is filed and keeps blocking, each non-blocker joins the deferral, and the receipt names the unplanned record. It is never a clean review, and filing is not a resolution: a later review still sees the blocker.

## Proof

One rule, shared by the review that states `proof:`, the `fix` that runs it, and the falsification gate that tries to break it.

- A proof is an executable observation of consumer-visible behaviour, a boundary, a transition, or an error, and it exercises every `paths:` entry. Where the repository has what it needs, it runs as a test inside the repository, through the repository's own test command.
- It fails while the mechanism holds — on the `failure:` scenario — and passes once `restored:` holds.
- Not proof: an assertion on source or prose text, a check that one place copies another (a wiring copy), or a mock that echoes what the test fed it. A cause whose `proof:` is one of these is not eligible to apply.
- A cause whose mechanism is a missing or weak test is planned like any other: `failure:` is the unsafe behaviour the existing guard prevents, left unobserved when that guard breaks; `fix:` adds the test; `proof:` is that test. The falsification gate breaks the existing guard instead of one the commit introduced.
- `proof: NO TEST: <reason>` is legal only with a reason the review's NO TEST policy allows (`dev-review` Phase 2 steps 5–5a), plus the evidence that stands instead. It is an explicit skip: never recorded as a passing test, never reported as proven.
- A proof that needs infrastructure, a command or a service the repository does not have cannot run here. `fix` does not create it, and the falsification gate reports `skipped` with that reason.
- An accepted proof — a test in the diff that executes the behaviour, or a NO TEST row legal under that policy — is not demanded again by a later review without new evidence of a defect (`dev-review` Phase 4 step 3b). A skip reported in a fix receipt is not an accepted proof.
