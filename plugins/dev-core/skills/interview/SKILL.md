---
name: interview
argument-hint: [topic | --promote <path>]
description: Structured interview → brainstorm | analysis | spec (with promotion). Triggers: "create a spec" | "interview" | "brainstorm" | "write analysis" | "promote to spec".
version: 0.1.0
allowed-tools: AskUserQuestion, Write, Read, Edit, Glob
---

# Interview

Conduct a structured interview with the user to produce one of three document types: **Brainstorm**, **Analysis**, or **Spec**. Supports promoting an existing document to the next level.

## Instructions

### Step 0 — Check for `--promote` Flag

If the user passes `--promote <path>`:

1. Read the document at the given path.
2. Determine its current type from frontmatter first, then content structure as fallback:
   - **Primary check:** If it has `type: brainstorm` in frontmatter, treat it as a **Brainstorm** and promote to **Analysis**.
   - **Fallback:** If no `type` frontmatter but lives in `artifacts/analyses/` with a "Trigger" / "Ideas" structure, treat it as a **Brainstorm**.
   - If it lives in `artifacts/analyses/` with "Questions Explored" / "Analysis" / "Conclusions" structure, treat it as an **Analysis** and promote to **Spec**.
   - If it is already a Spec, inform the user: "This document is already a spec. Nothing to promote."
3. Skip to **Step 2** (interview), but limit questions to the gaps between the current document and the next level's template. Pre-fill what you already know from the source document.
4. When generating the promoted document, add a link back to the source:
   - In the new document's Context section, add: `**Promoted from:** [source title](relative-path-to-source)`

If no `--promote` flag, continue to Step 1.

### Step 1 — Existing Document Awareness

Before asking the document type, scan for related documents:

```
artifacts/analyses/   — existing analyses
artifacts/specs/      — existing specs
```

Use **Glob** to search for files matching the topic (by issue number, keywords, or slug). Also check if the user's arguments mention a GitHub issue number.

**If related documents are found**, use AskUserQuestion to ask:

> "I found existing documents related to this topic:
> - {list of documents with paths}
>
> How would you like to proceed?"

Options:
- **Build on existing** — Use the existing document as context and extend it
- **Promote to next level** — Promote an analysis to spec (or brainstorm to analysis)
- **Start fresh** — Ignore existing documents and begin a new interview

If no related documents are found, proceed directly to asking the document type.

### Step 2 — Determine Document Type

Use **AskUserQuestion** to ask the user which document type to create:

| Type | Purpose | Output Path |
|------|---------|-------------|
| **Brainstorm** | Explore ideas, divergent thinking, early-stage exploration | `artifacts/analyses/{slug}.mdx` |
| **Analysis** | Structured investigation of a topic or problem | `artifacts/analyses/{slug}.mdx` |
| **Spec** | Technical specification for implementation | `artifacts/specs/{issue}-{slug}.mdx` |

If promoting, this step is already determined — skip it.

### Step 3 — Structured Interview

Conduct the interview using **AskUserQuestion**. Follow the four-phase framework below. Group 2-4 questions per call for efficiency. **Skip questions whose answers are obvious from context, arguments, or an existing source document.**

#### Phase 1 — Context & Framing (2-3 questions)

- What triggered this? What is the problem or opportunity?
- What exists today? What has been tried?

**Analysis-specific framing (capture raw source + appetite):**

When the interview is for an **Analysis** document, Phase 1 should also capture:

- **Source material:** "Can you share the original request, user quote, Slack message, or support ticket that triggered this?" Preserve verbatim — this is ground truth.
- **Outcome:** "What does success look like — without prescribing a solution?"
- **Appetite:** "What's the time budget for this work? (e.g. 1 week, 2-week cycle)" This constrains design — fixed time, variable scope.

#### Phase 2 — Scope (2-3 questions)

- Who are the users? What are their workflows?
- What is explicitly out of scope?
- What are the constraints (technical, time, dependencies)?

#### Phase 3 — Depth (2-4 questions, adapt to topic)

- What are the edge cases and failure modes?
- What are the trade-offs being considered?
- How does this integrate with existing systems?
- What does success look like?

> **Shape Up terminology:** A *shape* is a mutually exclusive architecture approach — each has a name, trade-offs, and rough scope. A *breadboard* maps a shape into connected affordance tables (UI elements → code handlers → data stores). *Slices* break a shape into demo-able vertical increments. These concepts are explored during the interview and formalized in the output templates below.

**Analysis-specific depth (multi-shape exploration):**

When the interview is for an **Analysis** document, Phase 3 should also explore:

- **Architecture shapes:** "What are 2-3 mutually exclusive approaches to solving this?" For each shape, capture: name, description, trade-offs, and rough scope.
- **Constraint alignment:** "Which constraints or requirements would eliminate any of these approaches?"

**Spec-specific depth (ambiguity detection):**

When the interview is for a **Spec** document (or promoting to spec), Phase 3 should also probe for ambiguity using the **9-category taxonomy**:

| Category | Example probe |
|----------|--------------|
| Functional Scope | "What exactly happens when X?" |
| Domain & Data Model | "What entities are involved? What are the relationships?" |
| UX | "What does the user see/do at each step?" |
| Non-Functional | "What are the performance/scale/reliability requirements?" |
| Integrations | "What external systems does this touch?" |
| Edge Cases | "What happens when X fails or is missing?" |
| Constraints | "What technical/time/budget limits apply?" |
| Terminology | "Are there terms that could mean different things to different people?" |
| Completion Signals | "How do we know this is done? What does success look like?" |

For each ambiguity detected, rank by **Impact x Uncertainty** (High/Medium/Low for each). High-Impact + High-Uncertainty items become interview follow-up questions. Ambiguity that impacts implementation can be marked inline as `[NEEDS CLARIFICATION: description]` (max 3-5 per spec). These must be resolved before `/plan` execution.

> **Example:** During a Spec interview about user notifications, the probe "What external systems does this touch?" (Integrations) reveals uncertainty about whether to use SendGrid or Resend for email. Scored as High-Impact (core feature) x High-Uncertainty (no prior evaluation) → becomes a follow-up question: "Which email provider should we evaluate?" If unresolved after interview, mark as `[NEEDS CLARIFICATION: email provider selection — SendGrid vs Resend]` in the spec.

**Adapt depth by document type:**

- **Brainstorm**: Focus on Phase 1 and divergent exploration. Ask "What else?" and "What if?" questions. Depth can be lighter.
- **Analysis**: Cover Phases 1-3 thoroughly. Probe for structure and conclusions.
- **Spec**: Cover all four phases. Be rigorous about edge cases, constraints, and success criteria.

#### Phase 4 — Validation (1 question, always last)

Present a structured summary of your understanding and ask for corrections before generating:

> "Here is my understanding before I generate the document:
> - **Type**: {type}
> - **Title**: {proposed title}
> - **Key points**: {bulleted summary}
>
> Anything to correct or add?"

### Step 4 — Generate the Document

Write the document using the appropriate template below. Follow these rules:

- Use `.mdx` extension with YAML frontmatter (`title`, `description`).
- Use kebab-case slugs.
- For **Spec** documents, prefix the filename with the GitHub issue number: `artifacts/specs/{issue}-{slug}.mdx`
- For **Analysis** and **Brainstorm** documents: `artifacts/analyses/{slug}.mdx` (prefix with issue number if one exists, e.g., `artifacts/analyses/{issue}-{slug}.mdx`).
- Brainstorm documents add `type: brainstorm` to their frontmatter.
- Escape `<` as `&lt;` in MDX content to avoid JSX parsing errors.

---

## Document Templates

Use templates from [references/templates.md](references/templates.md) — Brainstorm, Analysis, Spec.

$ARGUMENTS
