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

## Frontmatter contract

| Field | When | Value |
|-------|------|-------|
| `title` | always | `"ADR-{NNN}: {Title}"` (quoted) |
| `description` | always | one-line summary, no newline |
| `status` | always | one of the vocabulary above (lowercase) |
| `normative` | always | `true` ⟺ `status ∈ {proposed, accepted}`; `false` ⟺ `status ∈ {deprecated, superseded}` |
| `date` | always | `YYYY-MM-DD` — the decision date |
| `superseded_by` | ⟺ `status: superseded` | `ADR-{NNN}` of the replacement; absent otherwise |
| `axial` | at most one | `true` on the one Axis of Decomposition ADR; absent on every other ADR |

Two ADRs carrying `axial: true` name two axes of decomposition — the corpus can
never hold both. Zero is legal: it means the axis has not been declared yet, and
`/R-adr --axial` declares it. A repo that has declared one can require it to stay
declared with `AGENTS_ADR_AXIAL_MODE=fail` in the hygiene gate.

`normative` marks **binding authority**: ADRs in force are `true`, so one grep
separates law from working notes. It only keeps its meaning because
`superseded` and `deprecated` ADRs flip it to `false` — an ADR that stopped
being law must stop claiming to be law.

There is no `## Status` body section. Status lives in frontmatter, once.

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
