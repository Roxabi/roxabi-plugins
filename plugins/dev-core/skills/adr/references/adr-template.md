# ADR template — canonical

**This file is the only definition of ADR frontmatter and section skeleton.**

Every writer derives from it; none restates it. `/R-adr` Create Mode and
`/R-adr --axial` (`references/axial-interview.md`) both read this file and emit
the skeleton below. The hygiene gate
(`plugins/dev-core/scripts/check-agents-adr-hygiene.sh`) enforces the same
contract from the other side, and a guard test keeps the two in step.

Duplicating the skeleton into a writer is how the skill and the axial agent
drifted apart (the skill emitted `title` + `description`, the axial path emitted
those plus `axial: true`, and list mode read `status` + `date` that nobody
wrote). Point at this file instead.

## Contract version

<!-- adr:contract-version -->v2<!-- /adr:contract-version -->

Bumped whenever the enforced contract changes — vocabulary, fields, or rules.
The hygiene gate declares the same number and a guard test binds the two, so a
vocabulary change that forgets the bump is caught at build time.

The gate ships **by value** into consumer repositories: `/R-dev-init` copies the
script, and a copy is frozen at the version it was taken at. A frozen copy
rejecting a legal ADR is indistinguishable from an illegal ADR unless the copy
says which contract it implements, so every gate verdict names its version and
`/R-dev-init` reports a copy that is behind.

## Status vocabulary

Lowercase, closed set. One definition, both writers and the gate consume it.

<!-- adr:status-vocabulary -->
`proposed` `accepted` `deprecated` `superseded`
<!-- /adr:status-vocabulary -->

| Status | Meaning | Archive? |
|--------|---------|----------|
| `proposed` | Decision drafted, not yet ratified | no |
| `accepted` | In force — binding law | no |
| `deprecated` | No longer applies, **nothing replaced it** | **no** — deprecated is not replaced, it stays in place |
| `superseded` | Replaced by a later ADR | **yes** — moves to `archived/` |

Status is about the record **as a whole**. An ADR that is in force except for a
part someone replaced is `accepted`, and names the exception in
`superseded_in_part_by` — see below. Rounding it to `superseded` retires a
record still binding; rounding it to plain `accepted` republishes a retired part
as law. Both are false, and the second is silent.

## Filename

`{NNN}-{slug}.md` — NNN zero-padded to **3 or 4 digits**, slug kebab-case.
Legacy `.mdx` is read but never written.

The width bound is load-bearing, not cosmetic: the next number is
`max(NNN) + 1` over the whole corpus, so anything the pattern wrongly admits
sets it. `2026-08-24-notes.md` beside `001`–`005` allocated `2027`. A
`YYYY-MM-DD-` prefix is a dated note, never a number.

One number names one decision. Two files claiming the same number — `001-a.md`
beside `0001-b.md` — is a violation in both readers.

## Frontmatter contract

| Field | When | Value |
|-------|------|-------|
| `title` | always | `"ADR-{NNN}: {Title}"` (quoted) |
| `description` | always | one-line summary, no newline |
| `status` | always | one of the vocabulary above (lowercase) |
| `normative` | always | `true` ⟺ `status ∈ {proposed, accepted}`; `false` ⟺ `status ∈ {deprecated, superseded}` |
| `date` | always | `YYYY-MM-DD` — the decision date (see below) |
| `superseded_by` | ⟺ `status: superseded` | `ADR-{NNN}` of the replacement; absent otherwise |
| `superseded_in_part_by` | optional, **⟹ `normative: true`** | YAML flow list of `ADR-{NNN}` and/or `#{NNN}`; absent otherwise |
| `axial` | at most one | `true` on the one Axis of Decomposition ADR; absent on every other ADR |

Booleans are spelled `true` / `false`. `True`, `yes` and `on` are the same value
to a YAML parser and are rejected here, because a reader that matches the
literal `true` sees an aliased `axial: True` as *no axis declared* — which is
the signal that starts the interview that writes a second axial ADR.

Two ADRs carrying `axial: true` name two axes of decomposition — the corpus can
never hold both. Zero is legal: it means the axis has not been declared yet, and
`/R-adr --axial` declares it. A repo that has declared one can require it to stay
declared with `AGENTS_ADR_AXIAL_MODE=fail` in the hygiene gate.

### `normative` — binding authority, whole or partial

`normative` answers **whether** the ADR binds, not **how much**. `true` means
"this record is law"; one grep separates law from working notes. It only keeps
that meaning because `superseded` and `deprecated` ADRs flip it to `false` — an
ADR that stopped being law must stop claiming to be law.

A partially-superseded ADR stays `normative: true`. It *is* law for every part
nobody replaced, and demoting it would retire clauses still in force. The
exception is carried by `superseded_in_part_by`, so the two-grep idiom is:

```bash
grep -rl 'normative: true' docs/architecture/adr           # everything that binds
grep -rL 'superseded_in_part_by' $(grep -rl 'normative: true' …)   # binds in whole
```

### `superseded_in_part_by` — "in force, except these parts"

Present on an ADR that is still binding and has lost a part. Entries name what
replaced that part:

- `ADR-{NNN}` — a later decision took over the part.
- `#{NNN}` — a change retired the mechanism and recorded no new decision. This
  shape exists so that an unrecorded retirement can be *stated* rather than
  forced into a successor that does not exist. Inventing one, or editing the
  status instead, is how a decision log is falsified.

Illegal on `deprecated` and `superseded`: a record that is wholly replaced has
no parts left in force. `bun adr.ts supersede-in-part --nnn N --by <ref>` writes
it; `supersede` and `deprecate` strip it, for the same reason.

### `date` — the decision date, and its floor

`date` is when the decision was **taken**, not when it was written down, edited,
or retired. In particular the date on a "Superseded — YYYY-MM-DD" line is when
the decision *stopped* applying; migration never reads it as `date`.

When the true decision date is unrecoverable — the ADR predates the repository,
or arrived in a squashed import — `date` is the **earliest date at which the
decision is known to have existed**: the file's first commit. It is a floor, and
the real decision is that day or earlier, never later. Migration fills it from
git for exactly this reason, and a corpus imported in one commit will therefore
share one date; that is the floor showing through, not twelve decisions taken on
one afternoon. Prefer a known date over the floor whenever the body records one.

There is no `## Status` body section. Status lives in frontmatter, once. Body
prose — including a supersession banner — is commentary; every fact a reader or
a gate acts on lives in frontmatter.

## Skeleton

Slug = kebab-case title. Path `docs/architecture/adr/{NNN}-{slug}.md`
(archived: `docs/architecture/adr/archived/{NNN}-{slug}.md`). Always `.md`.

```md
---
title: "ADR-{NNN}: {Title}"
description: {one-line summary}
status: accepted
normative: true
date: {YYYY-MM-DD}
---

## Context

{What is the issue? Why does this decision need to be made?}

## Options Considered

### Option A: {Name}
- **Pros:** {advantages}
- **Cons:** {disadvantages}

### Option B: {Name}
- **Pros:** {advantages}
- **Cons:** {disadvantages}

## Decision

{What was decided and why.}

## Consequences

### Positive
- {benefit}

### Negative
- {trade-off}

### Neutral
- {side effect}
```

Default `status: accepted` unless the writer states otherwise. Min 2 options.

## Axial delta

`/R-adr --axial` writes the same skeleton with three deltas — it does **not**
define a second template:

1. Frontmatter gains `axial: true` (singleton across the whole ADR directory,
   `archived/` included).
2. `title` is `"ADR-{NNN}: Axis of Decomposition"`, slug
   `{NNN}-axis-of-decomposition.md`.
3. `## Consequences` gains `### Anti-pattern signal` and `### Revisit triggers`
   subsections, and `### Negative` is titled `### Negative (Expected Debt)`.

Section content for those deltas is specified in
[axial-interview.md](axial-interview.md) Phase 4.
