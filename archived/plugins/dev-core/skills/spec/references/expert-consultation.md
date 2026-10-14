# Expert Consultation

## During Document Writing

When domain expertise is needed while writing the analysis or spec, spawn the relevant expert subagent:

```
Task(
  description: "Expert consultation - <topic>",
  subagent_type: "R-architect" | "R-doc-writer" | "R-devops" | "R-product-lead" | "R-adversarial",
  prompt: "Research and answer: <specific question>. Return findings as bullet points."
)
```

| Expert | Use for |
|--------|---------|
| **R-architect** | Trade-off analysis, feasibility checks, architecture decisions, integration concerns |
| **R-doc-writer** | Document structure advice, Markdown conventions (legacy `.mdx` edit-in-place only), clarity feedback |
| **R-devops** | CI/CD feasibility, deployment strategy, infrastructure requirements |
| **R-product-lead** | Product fit, acceptance criteria, user story validation |
| **R-adversarial** | Kill the design: bypass paths, vacuous AC, unstated assumptions, missing failure flows |

Do NOT spawn experts upfront — only when a specific question arises during writing.

## At Review Gates (1b, 2b)

Expert review at gates is auto-selected based on document content (see Step 4 (Expert Review) in SKILL.md). Spawn all selected reviewers in parallel for maximum speed.
