# Reasoning Audit Template

Before critical steps, α must present structured reasoning checkpoint → user approval.

## Template

```
## Reasoning Audit — {step_name}

**Understanding:** {1-3 sentences: what the agent knows about the task}
**Key files:** {files/artifacts to read or modify}
**Approach:** {strategy — how to proceed, not implementation details}
**Risks:** {ambiguities, unknowns, potential wrong turns}
```

## Field Guidance

| Step | Understanding | Key files | Approach | Risks |
|------|--------------|-----------|----------|-------|
| spec | Analysis/frame content, target outcome | Source doc, existing specs, standards | Interview focus, breadboard shape, slice strategy | Source ambiguities, missing context, scope creep |
| plan | Spec scope + τ | Spec, standards, existing code | α selection, slice strategy, parallelism | Spec ambiguities, unclear boundaries, missing standards |
| implement | What to build, from which plan/spec | Files to create/modify by α | Parallel vs sequential, test-first, slice focus | Missing deps, unclear spec, complex integrations |

## Gate Options

AskUserQuestion:
- **Proceed** — continue to execution
- **Adjust approach** — incorporate feedback, re-present (max 3 rounds)
- **Abort step** — mark skipped for this run

## Why

Forces α to articulate plan before executing. Catches misunderstandings pre-impl (cheaper than post-fix). Reduces sycophancy via neutral statement of understanding before action.
