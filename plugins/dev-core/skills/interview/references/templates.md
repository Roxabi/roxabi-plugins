# Document Templates

## Brainstorm

Output path: `artifacts/analyses/{slug}.mdx`

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

{Free-form text: which ideas to pursue, what needs more research, suggested next steps — analysis, prototype, spec, etc.}
```

## Analysis

Output path: `artifacts/analyses/{slug}.mdx`

```mdx
---
title: "{Title}"
description: {One-line description of the analysis}
---

## Source

{Verbatim raw material — user quotes, Slack messages, issue descriptions, support tickets. Preserve original wording as ground truth. Append new material as it arrives.}

## Problem

{Distilled from Source — what is broken or painful. One or two sentences. No solutions.}

## Outcome

{Solution-agnostic success definition — what does "done" look like without prescribing how to get there.}

## Appetite

{Time/effort budget that constrains design. e.g. "1 week" or "2-week cycle". Fixed time, variable scope — the appetite forces trade-offs between quality, time, and scope.}

## Context

{Additional background — motivation, prior art, what exists today, what has been tried}

## Questions Explored

{The specific questions this analysis seeks to answer}

## Analysis

{Body of the analysis — findings, comparisons, data, reasoning}

## Shapes

{2-3 mutually exclusive architecture approaches. Skip for Tier S.}

### Shape 1: {Name}

- **Description:** {What this approach does}
- **Trade-offs:** {Pros and cons}
- **Rough scope:** {Estimated effort and files touched}

### Shape 2: {Name}

- **Description:** {What this approach does}
- **Trade-offs:** {Pros and cons}
- **Rough scope:** {Estimated effort and files touched}

## Fit Check

{Binary validation matrix — ✅ meets requirement, ❌ does not. No partial marks — ambiguity belongs in `[NEEDS CLARIFICATION]` markers or Breadboard unknowns, not here.}

| Requirement | Shape 1 | Shape 2 | Shape 3 |
|-------------|---------|---------|---------|
| {Req 1}     | ✅      | ❌      | ✅      |
| {Req 2}     | ✅      | ✅      | ❌      |

**Selected shape:** {Name} — {One-line rationale}

## Conclusions

{Key takeaways and decisions reached}

## Next Steps

- {Concrete action to take}
- {Further investigation if needed}
- {Link to spec if one should be created}
```

## Spec

> **Inline ambiguity markers:** `[NEEDS CLARIFICATION: description]` markers indicate unresolved ambiguity (max 3-5 per spec). These must be resolved before `/plan` execution.

Output path: `artifacts/specs/{issue}-{slug}.mdx`

```mdx
---
title: "{Title}"
description: {One-line description of the feature or project}
---

## Context

{Why this feature/project exists — background, dependencies, what it unblocks}

## Goal

{What this should accomplish — the desired outcome}

## Users & Use Cases

{Who uses this and how — roles, workflows, scenarios}

## Expected Behavior

### Happy path

{Main flow — step by step}

### Edge cases

{Edge cases and how they should be handled}

## Breadboard

{Map the selected shape into connected affordance tables. Skip for Tier S.}

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

{Unknowns: Mark any uncertain wiring — these trigger investigation spikes during `/analyze` before spec execution.}

## Slices

{Break the selected shape into demo-able vertical increments. Each slice is a working subset. Skip for Tier S.}

| Slice | Description | Affordances | Demo |
|-------|-------------|-------------|------|
| V1 | {Minimal working version} | U1, N1, S1 | {What can be demonstrated} |
| V2 | {Next increment} | U2, N2, S1 | {What can be demonstrated} |

## Constraints

- {Technical constraints}
- {Time or resource constraints}
- {Dependencies on other systems or issues}

## Non-goals

{What is explicitly out of scope for this spec}

## Technical Decisions

{Key architectural choices, trade-offs, and rationale}

## Success Criteria

- [ ] {Measurable criterion}
- [ ] {Measurable criterion}

## Open Questions

{Unresolved points to clarify before or during implementation}
```
