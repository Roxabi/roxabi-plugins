# Spec Templates

Let: N := issue number | τ := tier

Templates used by the spec skill for document generation.

## Spec Document Template

Frontmatter contract: [artifact-frontmatter.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/artifact-frontmatter.md).

````md
---
title: "{title|yaml-escaped}"
description: "{one-line description}"
type: spec
status: draft
---

## Context

**Promoted from:** [{analysis title}]({relative path to analysis})
**GitHub issue:** #{N}

## Intent

{1–3 short paragraphs or bullets: what we seek to solve — pain / gap / broken invariant, why now, observable impact. From SRC Problem. Not the solution shape.}

## Goal

{one sentence — observable done-when outcome}

## Users

{who is affected — role + workflow context}

## Expected Behavior

{narrative walkthrough from user perspective}

## Data Model & Consumers

### Data Structure

{Core types/models, fields, relationships. Note frozen vs mutable where useful. Markdown only — no HTML sidecars.}

### Consumers

| Consumer | Fields consumed | When | Status |
|----------|----------------|------|--------|
| Consumer 1 | field_a | {trigger} | This issue |
| Consumer 2 | sub.field_b | {trigger} | Future |

## Breadboard

### {Affordance Group 1}

| ID | Element | Handler | Data |
|----|---------|---------|------|
| U1 | {UI element} | {code handler} | {data store} |
| N1 | {API endpoint} | {controller} | {model} |
| S1 | {service/event} | {handler} | {store} |

### Wiring

{How IDs connect — e.g. "U1 triggers N1 which writes to S1"}

## Slices

| # | Name | Scope (IDs) | Demo criteria |
|---|------|-------------|---------------|
| 1 | {slice name} | U1, N1, S1 | {what you can demo} |
| 2 | {slice name} | U2, N2 | {what you can demo} |

## Success Criteria

- [ ] {binary criterion — passes or fails, no ambiguity}
- [ ] {binary criterion}
- [ ] {fail-closed / security / guard criterion — MUST include the priced block below}

```yaml
priced:  "<property the control must enforce>"
not:     "<implementation proxy that is NOT the property>"
oracles: ["concrete input that must fail closed"]
claim:   [fail-closed]   # required whenever this fence exists — closed set: fail-closed | authz | ssot
```

Implementer + tester test `priced` + `oracles`, never `not`. **`claim`** drives `/dev-review` security-class spawn (see #419).

## Open Questions

{Any [NEEDS CLARIFICATION: description] items unresolved. Max 5. Must resolve before /dev-plan.}
````