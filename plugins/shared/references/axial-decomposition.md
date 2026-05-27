# Axial Decomposition — Reference

> Foundational decision: which axis of variation is **primary** in your system. Without it, projects drift N×M (target × concern duplication).

## The trap

When a system varies along multiple axes (e.g., transport targets × cross-cutting concerns), code naturally duplicates along the **wrong** axis. Symptom: adding the 4th target requires copy-pasting the same 5 concerns again. Each cell of the N×M matrix gets its own (drifted) copy.

## The decision

Pick the **primary axis** — the one that grows by +1 row (not by ×M cells) when the system is extended.

| Pattern | Axis candidates | Typical primary |
|---------|-----------------|-----------------|
| Transport adapters | targets × concerns | concerns (stages) |
| DDD domain | domains × layers | domains |
| Data pipeline | stages × pipelines | stages |
| Multi-tenant | tenants × features | features |

## The 4 mandatory questions

1. **Axes** — name the dimensions of variation, list instances now, expected growth over 12 months.
2. **Primary** — which axis grows by 1 row when extended? Reason category: **stability** | **composition** | **ownership**.
3. **Anti-pattern signal** — concrete grep-able pattern (file glob, regex, symbol) that would indicate drift along the wrong axis.
4. **Expected debt** — what trade-off does this choice accept? Where will it bite later? (Force naming, no hidden cost.)

Optional Q5: **Revisit trigger** (default: sibling-fix rate > 3/week ∨ 6-monthly review).

## Persistence

- ADR with `axial: true` in frontmatter → **canonical marker** (grep-discoverable)
- No YAML pointer needed — `grep -rli "^axial: true" docs/architecture/adr/` finds it in O(N) ADR files (<50 in practice)
- Downstream consumers: `/init`, `/spec`, `/code-review`, `/checkup`, `/axis-check`, lint rules, sibling-rate detection all read this ADR directly

## Why mandatory at `/init`

`/init` is the only moment where the cost of asking is **zero**. Once scaffolding lands, the axis is implicit in the code structure — changing it costs a refactor. Forcing the decision now makes it:

- **Defendable** — written rationale, not folklore
- **Revisitable** — superseded, not lost
- **Visible** — surfaces the design choice that would otherwise stay invisible (the 1st of 4 N×M angles morts)

## Reason categories

Reject vague answers. Push the user toward one of:

| Category | Pattern |
|----------|---------|
| **Stability** | "Axis X changes rarely; axis Y multiplies fast → X is primary" |
| **Composition** | "Axis X primitives compose to express axis Y instances → X is primary" |
| **Ownership** | "Axis X is owned by one stable team/concern; axis Y is product-driven → X is primary" |

## Anti-pattern catalog (Roxabi)

| Slug | Signal | Fix |
|------|--------|-----|
| `target-axis-trap` | Scaffolding a bounded context per integration target → N×M code | Compose stages, leaf-target as YAML |
| `dispatch-on-type` | if/elif on adapter type in business logic | Adapter registry / DI |
| `god-adapter` | Single adapter >300 lines, mixed concerns | Split by concern (the primary axis) |

## Three-strikes rule

If a concern X appears in 3+ sibling dirs, it's no longer a coincidence — it's a duplication. Promote it to a shared primitive along the **primary axis**.

## Boundaries

This reference describes the **decision** + the **interview**. It does NOT prescribe a specific axis — every system has its own answer. Surface trade-offs; the project owner picks.
