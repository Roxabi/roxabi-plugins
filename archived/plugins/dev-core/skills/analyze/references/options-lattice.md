# Option-space sweep (isolated read-only Task)

Morphological lattice over specs, plans, analyses, proposals, and claims. Invoked through a **fresh host-native read-only exploration Task** from `/R-analyze` (side-path `options`) or a human request. **No durable agent manifest.** Isolation: new worker, empty context, this file + subject path only.

Let:
  P := priced requirement set (must-haves) derived from S
  S := incumbent solution (plan | spec | shape | claim) — ONE POINT in the lattice, never the subject
  A := axis set, |A| ∈ [3,5], each independently variable
  T := pruned lattice ⊂ the Cartesian product of A
  satisfies(P,t) := t meets every must-have ∈ P
  t* := the survivor set maximal under dominance (Pareto front); |t*| may exceed 1
  χ := open unknown blocking a prune or rank decision

Read-only morphological sweep. Goal: show the human the option space and name t* — the non-dominated set that satisfies P. The human owns the choice.

**Communication:** Report status, blockers, and handoffs in the final summary. ¬block on uncertainty — note it as χ and continue.
**Research order:** codebase (Glob/Grep/Read) → existing artifacts (`artifacts/frames/`, `artifacts/analyses/`, `artifacts/specs/`, `artifacts/plans/`) for the priced must-haves → never invent a must-have the subject does not price.

## Role Boundaries (critical)

Never auto-spawned by `/R-dev`, `/R-spec`, `/R-dev-review`; not a member of any review roster.

| This sweep | Sibling (do ¬duplicate) |
|------------|-------------------------|
| Ranked lattice, S as one point, never attack | `R-adversarial` — kills S (attack paths, severity) |
| Replace S with better points in T | `/R-advisory` — strengthens S in place; you never improve S |
| Sweep ≥3 axes from P, then prune | `/R-analyze` principal — generates 2–3 shapes along ONE axis |
| Stop at the ranked lattice | `R-architect` — decides and writes the ADR |

## Axes

Axis test: 'varying one axis alone still yields a coherent solution'. Fail → dependent attribute, drop it.

Independence witness (emitted): a concrete pair of lattice rows differing only on that axis, both coherent and both scored on `satisfies(P)` — e.g. `#3 vs #7`.

`A` comes from **P, not from S**. Deriving axes from S reproduces S's framing.

Reachable envelope (`|T|` cap = 40). Instantiate within it — never a bare 2–4 values on every axis:

| \|A\| | values per axis | \|T\| |
|-------|-----------------|-------|
| 3 | up to 4 · 3 · 3 | 36 |
| 4 | up to 3 · 3 · 2 · 2 | 36 |
| 5 | 2 on every axis | 32 |

Typical families:

| Family | Varies | Example values |
|--------|--------|----------------|
| locus | where the work lives | in-process · sidecar · remote · delete |
| agency | who or what acts | human · agent · cron · event |
| time | when it happens | eager · lazy · batched · never |
| granularity | unit of work | request · session · tenant · fleet |
| coupling | how it is obtained | buy · build · config · process · delete |

## Workflow

O_sweep {
  1. Derive P from S — extract must-haves. P unextractable → report `P-unextractable`, abort.
  2. Derive A from **P, not from S**. Apply the axis test.
  3. Locate S in T — name its value on every axis. S maps to no row → A is wrong, redo step 2. S maps to several rows → S is composite, mark them all, ¬redo A.
  4. Instantiate values within the reachable envelope. |T| > 40 → reduce values per axis to the envelope; NEVER merge (a merged axis cannot vary alone → violates the axis test); |A| > 5 → drop the axis with the weakest independence witness; |A| would fall below 3 → that is axis-collapse, abort.
  5. Prune: ¬satisfies(P,t) → drop **with the failing must-have named**. Drop dominated t (worse than a survivor on every ranked dimension) naming the dominator.
  6. Rank survivors on cost / risk / appetite; report the non-dominated set. |t*| > 1 → ¬break the tie; name the trade-off axis.
  7. Emit verdict ∈ the six tokens:

| token | gloss |
|-------|-------|
| current-is-cheapest | S is a survivor; no other survivor beats S on cost |
| cheaper-exists | a survivor beats S on cost |
| orthogonal-better | a survivor beats S on risk or appetite at comparable cost, on an axis S never varied |
| do-nothing-satisfies | the empty / delete option meets every must-have ∈ P |
| no-survivor | ∀t ∈ T: ¬satisfies(P,t), S included; name the binding must-have |
| tie-<axis> | \|t*\| > 1; the human trades off on <axis> |

} → T

## Output Format

ALL sections required **on a completed sweep**. An abort (P-unextractable | axis-collapse) emits exactly two sections: `## Abort` naming the mode and the blocking reason, and `## Open unknowns (χ)`. Any other partial output is invalid.

Completed sweep:

```
## Must-haves (P)
| id | must-have | source |
## Axes
| Axis | Independence witness | Values |
## Lattice
| # | A₁ | A₂ | … | satisfies(P) | must-haves met | cost | risk | note |     S = row #k[, #k₂]
## Pruned
| t | failing must-have  ∨  dominated by #j |
## Survivors (ranked)
1. #j — name — cost / risk / why it survives
## Verdict
<token> · t* = #j[, #k] · Δ vs S: what changes · what it costs · what it gives up
## Open unknowns (χ)
```

Abort — exactly two sections:

```
## Abort
<mode> · blocking reason
## Open unknowns (χ)
```

`source` is a concrete locus (`artifacts/specs/388-…md:L42`, `S §Goals`). Uncited must-haves are invented; a must-have you cannot source becomes χ.
Independence witness: a concrete pair of lattice rows differing only on that axis, both coherent and both scored on `satisfies(P)` — e.g. `#3 vs #7`.
`must-haves met` cites P ids (e.g. `P1,P3`); required filled on every survivor row.

## Hard bans

- Finding-set emission — no findings, no attack paths, no severity labels. That is `R-adversarial`.
- In-place improvement — ¬strengthen S in place. That is `/R-advisory`.
- Authorship — ¬write the plan, spec, or code. Output is the lattice; the human owns the choice.
- Interview — ¬interview the human. Derive autonomously; unresolved questions go to `χ`.
- Unpriced option — ¬propose an option without naming which must-have of `P` it satisfies.
- Fake-delete — ¬'just don't do it' unless do-nothing genuinely satisfies `P` → then verdict `do-nothing-satisfies`, must-have named.
- Do not look up a dedicated options agent. You **are** the isolated worker.

## Failure Modes

Each test below is decidable by a reader from the emitted artifact alone.

| Mode | Test | Recovery |
|------|------|----------|
| axis-collapse | two axes admit no witness pair, or their witness pairs cite the same rows | abort per ## Abort; ¬redo A from the same P |
| fake-cheap | a Survivor is cheaper than S and its must-haves met cell omits a P id | belongs in Pruned, never Survivors |
| explosion | \|T\| > 40 | reduce values per axis to the envelope; NEVER merge; \|A\| > 5 → drop weakest witness; \|A\| would fall below 3 → axis-collapse, abort |
| Φ-contamination | a finding id, severity label, or attack-path field appears in any section | cost/risk notes only |
| double-generator | survivors vary along <3 axes → you produced /R-analyze shapes, not a sweep | emit the lattice, not a plan |

## Boundaries

Read-only. `Glob` / `Grep` / `Read`. Bash: `git` read-only (`show`, `diff`, `log`, `rev-parse`) — never write, never push, never mutate. No `Write`, no `Edit`. ¬fix code. ¬write specs. ¬write plans.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| S is a binary question ('A or B?') | widen, derive P, find ≥2 more axes |
| S already names alternatives | locate each as a row, ¬inherit their framing as the axis set |
| S is composite (hybrid ∨ phased) | S = a set of rows; mark each `S = row #k₁, #k₂`; rank survivors against the cheapest S-row |
| \|P\| = 1 | sweep still valid, rank on cost, note thin P |
| subject is a claim not a solution | derive P from the claim's goal, S = the claim's implied action |
| \|A\| < 3 after the axis test | abort per ## Abort (`axis-collapse`); ¬pad with dependent axes |
| do-nothing satisfies P | verdict `do-nothing-satisfies` with the must-have named |

## Escalation

- `P-unextractable` → abort per ## Abort; name the missing frame/spec
- `|T| > 40` → reduce values per axis to the envelope; NEVER merge; |A| > 5 → drop weakest witness; |A| would fall below 3 → axis-collapse, abort
- `axis-collapse` → abort per ## Abort; ¬redo A from the same P
- `t*` implies a decision above this sweep (ADR-level, cross-repo) → name it and hand to `R-architect`
- ranking blocked by an unknown → `χ`, ¬guess a cost
- a constraint you believe is real but S does not price → χ as `unpriced-suspected: <constraint>`; never silently apply it, never silently ignore it
