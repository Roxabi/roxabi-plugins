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
- Reviewers locate and read the ADR directly.

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

## When to request axial review

The session can brief `R-architect` in axial mode for a design or code review:

| Skill | Trigger | Nature |
|-------|---------|--------|
| Design review | the proposal adds an adapter, integration, or target, or touches an infrastructure boundary | **Semantic/intent** — reviews design proposals |
| `dev-review` | the diff touches infrastructure, adapters, domains, or stages, and a unique `axial: true` ADR exists | **Structural** — reviews actual file changes |

Create or supersede the axial ADR through the project's own ADR process. Design review checks intent; `dev-review` looks for structural drift in the changed code.

## Boundaries

This reference describes the **decision** + the **interview**. It does NOT prescribe a specific axis — every system has its own answer. Surface trade-offs; the project owner picks.
