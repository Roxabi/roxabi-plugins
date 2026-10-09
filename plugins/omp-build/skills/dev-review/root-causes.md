# Root causes

The unit of a fix. A finding is a symptom. A root cause is the shared mechanism behind one or more actionable findings. `dev-review` names them after dedup, before it posts. `fix` applies one change per well-formed cause that contains a blocking finding. A block missing a non-empty `mechanism:`, `fix:`, or `findings:` line is not applied, even when it contains a blocking finding. A well-formed cause with none is deferred, not applied. The plan is the decision.

Two readers: `dev-review` Phase 4 writes the section, `fix` Phase 2 reads it. Both reach this file as `skill://dev-review/root-causes.md`.

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

A finding with no usable root-cause sentence is its own cause until the cited lines show it shares a mechanism with another. Still unnamed after that read: its own cause.

## Record

One block per cause. Order: a cause that contains a blocker first, then by the highest confidence among its members. Every line is non-CC-shaped, per `dev-review/SKILL.md` Phase 4 § `/fix` partition.

The section ends at the next `##` heading. In a review, that heading is `## Findings`.

```markdown
## Root causes

### RC-1 — <one-line cause>
- mechanism: <why, not the symptom>
- fix: <the one change that removes the cause, covering every member callsite>
- findings: `path:line` — <exact final rendered description> ; `path:line` — <exact final rendered description>

## Findings
```

Finalize finding descriptions before building these references. Distinct findings at the same anchor have distinct mechanism-specific descriptions, with their original symptoms/evidence retained. Each `path:line` + exact description pair must resolve to exactly one finding under `## Findings`; each actionable finding belongs to at most one cause. A shared anchor never includes other findings implicitly. Zero/multiple matches or conflicting memberships do not authorize applying affected causes: keep findings for the existing uncited/per-finding filing/single-deferral paths, without reclustering the posted record.

No named causes → the section body is exactly `none`, including when actionable findings remain uncited. It is not an assertion that there are no actionable findings:

```markdown
## Root causes

none

## Findings
```

`fix` is Solution 1 of the strongest member, widened so every member callsite is covered. A fix line that only widens a denylist, adds a grep, or copies an inventory list is not a fix, whatever the members' classes. Name the oracle or single source of truth that must change.

Number `RC-1` upward. Do not reuse a number. Every cause has a non-empty `mechanism:`, `fix:` and `findings:`. An actionable finding that still has no mechanism and no fix stays out of this section; `fix` files it when it satisfies `blocks(f)`, and defers it into the single non-blocking follow-up otherwise.
