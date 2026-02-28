# Expert Consultation

## During Document Writing

When domain expertise is needed while writing the analysis or spec, spawn the relevant expert subagent:

```
Task(
  description: "Expert consultation - <topic>",
  subagent_type: "architect" | "doc-writer" | "devops" | "product-lead",
  prompt: "Research and answer: <specific question>. Return findings as bullet points."
)
```

| Expert | Use for |
|--------|---------|
| **architect** | Trade-off analysis, feasibility checks, architecture decisions, integration concerns |
| **doc-writer** | Document structure advice, MDX conventions, clarity feedback |
| **devops** | CI/CD feasibility, deployment strategy, infrastructure requirements |
| **product-lead** | Product fit, acceptance criteria, user story validation |

Do NOT spawn experts upfront — only when a specific question arises during writing.

## At Review Gates (1b, 2b)

Expert review at gates is auto-selected based on document content (see Step 4 (Expert Review) in SKILL.md). Spawn all selected reviewers in parallel for maximum speed.
