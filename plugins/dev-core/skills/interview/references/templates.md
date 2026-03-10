# Document Templates

Let: N := issue number | τ := tier

## Brainstorm

Output path: `artifacts/analyses/{slug}-analysis.mdx`

```mdx
---
title: "Brainstorm: {Title}"
description: {One-line description of what is being explored}
type: brainstorm
---

## Trigger

{What started this exploration — the problem, opportunity, or question}

## Ideas

- **{Idea 1}**: {Description}
  - Upside: {What makes this attractive}
  - Downside: {Risks or drawbacks}

- **{Idea 2}**: {Description}
  - Upside: {What makes this attractive}
  - Downside: {Risks or drawbacks}

- **{Idea 3}**: {Description}
  - Upside: {What makes this attractive}
  - Downside: {Risks or drawbacks}

## What's next?

{Free-form: which ideas to pursue, what needs research, next steps — analysis, prototype, spec, etc.}
```

## Analysis

Output path: `artifacts/analyses/{slug}-analysis.mdx`

```mdx
---
title: "{Title}"
description: {One-line description of the analysis}
---

## Source

{Verbatim raw material — user quotes, Slack messages, issue descriptions, support tickets. Preserve original wording. Append new material as it arrives.}

## Problem

{Distilled from Source — what is broken/painful. 1–2 sentences. No solutions.}

## Outcome

{Solution-agnostic success definition — what "done" looks like w/o prescribing how.}

## Appetite

{Time/effort budget constraining design. e.g. "1 week". Fixed time, variable scope — forces trade-offs.}

## Context

{Background — motivation, prior art, what exists, what's been tried}

## Questions Explored

{Specific questions this analysis answers}

## Analysis

{Findings, comparisons, data, reasoning}

## Shapes

{2–3 mutually exclusive architecture approaches. Skip for τ S.}

### Shape 1: {Name}

- **Description:** {Approach}
- **Trade-offs:** {Pros/cons}
- **Rough scope:** {Effort + files touched}

### Shape 2: {Name}

- **Description:** {Approach}
- **Trade-offs:** {Pros/cons}
- **Rough scope:** {Effort + files touched}

## Fit Check

{Binary validation: ✅ meets, ❌ ¬meets. Ambiguity → `[NEEDS CLARIFICATION]` markers.}

| Requirement | Shape 1 | Shape 2 | Shape 3 |
|-------------|---------|---------|---------|
| {Req 1}     | ✅      | ❌      | ✅      |
| {Req 2}     | ✅      | ✅      | ❌      |

**Selected shape:** {Name} — {One-line rationale}

## Conclusions

{Key takeaways + decisions}

## Next Steps

- {Concrete action}
- {Further investigation if needed}
- {Link to spec if applicable}
```

## Spec

> **Inline ambiguity markers:** `[NEEDS CLARIFICATION: description]` — unresolved ambiguity (max 3–5/spec). Must resolve before `/plan`.

Output path: `artifacts/specs/{issue}-{slug}-spec.mdx`

```mdx
---
title: "{Title}"
description: {One-line description of the feature or project}
---

## Context

{Why this exists — background, dependencies, what it unblocks}

## Goal

{Desired outcome}

## Users & Use Cases

{Who uses this + how — roles, workflows, scenarios}

## Expected Behavior

### Happy path

{Main flow — step by step}

### Edge cases

{Edge cases + handling}

## Breadboard

{Map selected shape → connected affordance tables. Skip for τ S.}

### UI Affordances

| ID | Element | Location | Trigger |
|----|---------|----------|---------|
| U1 | {Button, form, display...} | {Page/component} | {User action} |

### Code Affordances

| ID | Handler | Wiring | Logic |
|----|---------|--------|-------|
| N1 | {Function/endpoint} | U1 → N1 → S1 | {What it does} |

### Data Stores

| ID | Store | Type | Accessed by |
|----|-------|------|-------------|
| S1 | {Table, cache, API...} | {Persistent/transient/external} | N1, N2 |

{Unknowns: uncertain wiring → investigation spikes during `/analyze` before spec execution.}

## Slices

{Demo-able vertical increments. Each = working subset. Skip for τ S.}

| Slice | Description | Affordances | Demo |
|-------|-------------|-------------|------|
| V1 | {Minimal working version} | U1, N1, S1 | {What can be demonstrated} |
| V2 | {Next increment} | U2, N2, S1 | {What can be demonstrated} |

## Constraints

- {Technical constraints}
- {Time/resource constraints}
- {Dependencies on other systems/issues}

## Non-goals

{Explicitly out of scope}

## Technical Decisions

{Key arch choices, trade-offs, rationale}

## Success Criteria

- [ ] {Measurable criterion}
- [ ] {Measurable criterion}

## Open Questions

{Unresolved points to clarify before/during implementation}
```
