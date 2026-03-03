---
name: interview
argument-hint: [topic | --promote <path>]
description: Structured interview → brainstorm | analysis | spec (with promotion). Triggers: "create a spec" | "interview" | "brainstorm" | "write analysis" | "promote to spec".
version: 0.1.0
allowed-tools: Write, Read, Edit, Glob
---

# Interview

Let:
  β := Brainstorm | α := Analysis | σ := Spec
  τ := document type ∈ {β, α, σ}

Conduct structured interview → produce one of {β, α, σ}. Supports promoting existing doc to next level.

## Step 0 — Check for `--promote` Flag

∃ `--promote <path>`:

1. Read doc at path.
2. Determine current τ (frontmatter first, content structure fallback):
   - `type: brainstorm` in frontmatter → β → promote to α.
   - ¬type frontmatter ∧ lives in `artifacts/analyses/` ∧ "Trigger"/"Ideas" structure → treat as β.
   - `artifacts/analyses/` ∧ "Questions Explored"/"Analysis"/"Conclusions" structure → α → promote to σ.
   - Already σ → inform: "This document is already a spec. Nothing to promote." Stop.
3. Skip to Step 2; limit questions to gaps between current doc and next level. Pre-fill known from source.
4. In promoted doc's Context section: `**Promoted from:** [source title](relative-path-to-source)`

¬`--promote` → continue to Step 1.

## Step 1 — Existing Document Awareness

Glob `artifacts/analyses/`, `artifacts/specs/` — match topic by issue#, keywords, or slug.

∃ related docs → AskUserQuestion:
> "I found existing documents related to this topic: {list with paths}. How would you like to proceed?"
- **Build on existing** — use as context, extend
- **Promote to next level** — α → σ or β → α
- **Start fresh** — ignore, begin new interview

¬related docs → proceed to Step 2.

## Step 2 — Determine Document Type

∃ `--promote` → skip (already determined). Else AskUserQuestion:

| τ | Purpose | Output Path |
|---|---------|-------------|
| β | Divergent exploration, early-stage ideas | `artifacts/analyses/{slug}.mdx` |
| α | Structured investigation of topic/problem | `artifacts/analyses/{slug}.mdx` |
| σ | Technical specification for implementation | `artifacts/specs/{issue}-{slug}.mdx` |

## Step 3 — Structured Interview

AskUserQuestion per phase. Group 2–4 questions/call. Skip questions obvious from context, arguments, or source doc.

#### Phase 1 — Context & Framing (2–3 questions)

- What triggered this? What is the problem or opportunity?
- What exists today? What has been tried?

α-specific — also capture:
- **Source material:** verbatim request/quote/ticket (ground truth)
- **Outcome:** success without prescribing solution
- **Appetite:** time budget (e.g. 1 week, 2-week cycle) — fixed time, variable scope

#### Phase 2 — Scope (2–3 questions)

- Who are the users? What are their workflows?
- What is explicitly out of scope?
- What are the constraints (technical, time, dependencies)?

#### Phase 3 — Depth (2–4 questions, adapt to τ)

- Edge cases and failure modes?
- Trade-offs being considered?
- Integration with existing systems?
- What does success look like?

> **Shape Up terminology:** A *shape* = mutually exclusive architecture approach (name, trade-offs, rough scope). A *breadboard* maps a shape into affordance tables (UI elements → code handlers → data stores). *Slices* break a shape into demo-able vertical increments.

α-specific depth:
- **Architecture shapes:** 2–3 mutually exclusive approaches; ∀ shape: name, description, trade-offs, rough scope.
- **Constraint alignment:** which constraints eliminate any approach?

σ-specific depth — probe ambiguity via 9-category taxonomy:

| Category | Example probe |
|----------|--------------|
| Functional Scope | "What exactly happens when X?" |
| Domain & Data Model | "What entities/relationships are involved?" |
| UX | "What does the user see/do at each step?" |
| Non-Functional | "Performance/scale/reliability requirements?" |
| Integrations | "What external systems does this touch?" |
| Edge Cases | "What happens when X fails or is missing?" |
| Constraints | "What technical/time/budget limits apply?" |
| Terminology | "Terms that could mean different things to different people?" |
| Completion Signals | "How do we know this is done?" |

∀ ambiguity detected: rank by **Impact × Uncertainty** (H/M/L each). High×High → follow-up question. Unresolved after interview → mark inline as `[NEEDS CLARIFICATION: description]` (max 3–5/spec). Must be resolved before `/plan`.

> **Example:** Probe "What external systems does this touch?" reveals uncertainty about email provider. Scored High-Impact × High-Uncertainty → follow-up: "Which email provider should we evaluate?" If unresolved: `[NEEDS CLARIFICATION: email provider selection — SendGrid vs Resend]`.

Depth by τ:
- β: Phase 1 + divergent. Ask "What else?" / "What if?". Lighter depth.
- α: Phases 1–3 thoroughly. Probe for structure and conclusions.
- σ: All four phases. Rigorous on edge cases, constraints, criteria.

#### Phase 4 — Validation (1 question, always last)

> "Here is my understanding before I generate the document:
> - **Type**: {τ}
> - **Title**: {proposed title}
> - **Key points**: {bulleted summary}
>
> Anything to correct or add?"

## Step 4 — Generate the Document

Write using appropriate template. Rules:
- `.mdx` extension + YAML frontmatter (`title`, `description`)
- kebab-case slugs
- σ → prefix filename with GitHub issue#: `artifacts/specs/{issue}-{slug}.mdx`
- α ∧ β → `artifacts/analyses/{slug}.mdx` (prefix with issue# if ∃: `artifacts/analyses/{issue}-{slug}.mdx`)
- β → add `type: brainstorm` to frontmatter
- Escape `<` as `&lt;` in MDX content

---

## Document Templates

Use templates from [references/templates.md](references/templates.md) — Brainstorm, Analysis, Spec.

$ARGUMENTS
