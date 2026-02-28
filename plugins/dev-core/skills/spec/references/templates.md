# Spec Templates

Templates used by the spec skill for document generation.

## Spec Document Template

```mdx
---
title: "{title}"
description: "{one-line description}"
---

## Context

**Promoted from:** [{analysis title}]({relative path to analysis})
**GitHub issue:** #{N}

## Goal

{one sentence — what this builds and why}

## Users

{who is affected — role + workflow context}

## Expected Behavior

{narrative walkthrough of the feature from a user perspective}

## Breadboard

### {Affordance Group 1}

| ID | Element | Handler | Data |
|----|---------|---------|------|
| U1 | {UI element} | {code handler} | {data store} |
| N1 | {API endpoint} | {controller} | {model} |
| S1 | {service/event} | {handler} | {store} |

### Wiring

{How IDs connect across the breadboard — e.g. "U1 triggers N1 which writes to S1"}

## Slices

| # | Name | Scope (IDs) | Demo criteria |
|---|------|-------------|---------------|
| 1 | {slice name} | U1, N1, S1 | {what you can demo} |
| 2 | {slice name} | U2, N2 | {what you can demo} |

## Success Criteria

- [ ] {binary criterion — passes or fails, no ambiguity}
- [ ] {binary criterion}
- [ ] {binary criterion}

## Open Questions

{Any [NEEDS CLARIFICATION: description] items that remain unresolved. Max 5. Must be resolved before /plan.}
```
