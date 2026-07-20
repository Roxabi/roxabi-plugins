# interview

Structured interview → brainstorm, analysis, or spec artifact (with promotion between levels).

## Why

Unstructured conversations produce vague documents. `/interview` conducts a phased interview — context, scope, depth, validation — and produces a well-structured artifact at exactly the right level: brainstorm (divergent exploration), analysis (structured investigation), or spec (implementable specification).

## Usage

```
/interview                         Determine document type, then interview
/interview "topic"                 Seed interview with free text
/interview --promote path          Promote an existing doc to the next level
```

Triggers: `"create a spec"` | `"interview"` | `"brainstorm"` | `"write analysis"` | `"promote to spec"` | `"let's brainstorm"` | `"think through this"`

## Document types

| Type | Purpose | Output path |
|------|---------|-------------|
| Brainstorm (β) | Divergent exploration, early ideas | `artifacts/analyses/{slug}.md` |
| Analysis (α) | Structured investigation of a problem | `artifacts/analyses/{slug}.md` |
| Spec (σ) | Technical specification for implementation | `artifacts/specs/{issue}-{slug}.md` |

## Interview phases

1. **Context & Framing** — what triggered this, what exists today, what was tried
2. **Scope** — users, workflows, explicit out-of-scope, constraints
3. **Depth** — edge cases, trade-offs, integrations, success definition
   - Analysis: 2–3 architectural shapes with trade-offs
   - Spec: 9-category ambiguity taxonomy (functional scope, data model, UX, non-functional, integrations, edge cases, constraints, terminology, completion signals)
4. **Validation** — presents understanding summary, asks for corrections

## Promotion

```
/interview --promote artifacts/analyses/my-analysis.md
```

Detects the current document type from frontmatter/structure and promotes it to the next level (β → α → σ). Fills only the gaps between levels — preserves existing content.

## Output format

`.md` with YAML frontmatter (`title`, `description`, and `type: brainstorm` for brainstorms). Kebab-case slugs.
