# Reasoning Audit Template

Before executing a critical step, the agent must present a structured reasoning checkpoint and get user approval.

## Template

```
## Reasoning Audit — {step_name}

**Understanding:** {1-3 sentences: what the agent knows about the task}
**Key files:** {files/artifacts the agent plans to read or modify}
**Approach:** {strategy — how the agent will proceed, not implementation details}
**Risks:** {ambiguities, unknowns, potential wrong turns}
```

## Field Guidance Per Step

| Step | Understanding focus | Key files focus | Approach focus | Risks focus |
|------|-------------------|-----------------|----------------|-------------|
| spec | What the analysis/frame describes, target outcome | Source doc, existing specs, standards | Interview focus areas, breadboard shape, slice strategy | Ambiguities in source, missing user context, scope creep |
| plan | What the spec asks for, scope and tier | Spec, standards docs, existing code to reference | Agent selection, slice strategy, parallelism | Ambiguities in spec, unclear domain boundaries, missing standards |
| implement | What will be built, from which plan/spec | Files to create/modify, grouped by agent | Parallel vs sequential, test-first order, slice focus | Missing deps, unclear spec areas, complex integrations |

## Gate Options

AskUserQuestion:
- **Proceed** — continue to step execution
- **Adjust approach** — agent incorporates feedback, re-presents audit (max 3 rounds)
- **Abort step** — mark step skipped for this run

## Why

Forces the agent to articulate its plan before executing. Catches misunderstandings before implementation (cheaper than fixing after). Reduces sycophancy by requiring neutral statement of understanding before action.
