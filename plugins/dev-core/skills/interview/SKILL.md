---
name: interview
argument-hint: [topic | --promote <path>]
description: Structured interview → brainstorm | analysis | spec (with promotion). Triggers: "create a spec" | "interview" | "brainstorm" | "write analysis" | "promote to spec".
version: 0.2.0
allowed-tools: Write, Read, Edit, Glob, ToolSearch, AskUserQuestion
---

# Interview

Let:
  β := Brainstorm | α := Analysis | σ := Spec
  τ := document type ∈ {β, α, σ}
  A := `artifacts/analyses/` | S := `artifacts/specs/`

Conduct structured interview → produce one of {β, α, σ}. Supports promoting existing doc to next level.

## Step 0 — Check `--promote`

∃ `--promote <path>`:
1. Read doc at path.
2. Determine current τ (frontmatter first, content structure fallback):
   - `type: brainstorm` ∈ frontmatter → β → promote to α.
   - ¬type ∧ lives in A ∧ "Trigger"/"Ideas" structure → treat as β.
   - A path ∧ "Questions Explored"/"Analysis"/"Conclusions" structure → α → promote to σ.
   - Already σ → inform: "Already a spec. Nothing to promote." Stop.
3. Skip to Step 2; limit questions to gaps between current doc and next level. Pre-fill known from source.
4. In promoted doc's Context: `**Promoted from:** [source title](relative-path-to-source)`

¬`--promote` → Step 1.

## Step 1 — Existing Document Awareness

Glob A, S — match topic by issue#, keywords, or slug.

∃ related docs → AskUserQuestion:
> "Found existing documents: {list with paths}. How to proceed?"
- **Build on existing** — use as context, extend
- **Promote to next level** — α → σ or β → α
- **Start fresh** — ignore, begin new interview

¬related → Step 2.

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
- **Outcome:** success ¬prescribing solution
- **Appetite:** time budget (fixed time, variable scope)

#### Phase 2 — Scope (2–3 questions)

- Who are the users? What are their workflows?
- What is explicitly out of scope?
- Constraints (technical, time, dependencies)?

#### Phase 3 — Depth (2–4 questions, adapt to τ)

- Edge cases and failure modes?
- Trade-offs being considered?
- Integration with existing systems?
- What does success look like?

> **Shape Up terminology:** *shape* = mutually exclusive arch approach (name, trade-offs, rough scope). *breadboard* = affordance tables (UI elements → handlers → data). *slices* = demo-able vertical increments.

α-specific depth:
- **Architecture shapes:** 2–3 mutually exclusive approaches; ∀ shape: name, description, trade-offs, scope.
- **Constraint alignment:** which constraints eliminate which approach?

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
| Terminology | "Terms that could mean different things?" |
| Completion Signals | "How do we know this is done?" |

∀ ambiguity: rank by **Impact × Uncertainty** (H/M/L). H×H → follow-up question. Unresolved → `[NEEDS CLARIFICATION: description]` (max 3–5/spec). Must resolve before `/plan`.

Depth by τ: β = Phase 1 + divergent (lighter) | α = Phases 1–3 thorough | σ = all phases, rigorous on edge cases + criteria.

#### Phase 4 — Validation (1 question, always last)

> "My understanding before generating:
> - **Type**: {τ}
> - **Title**: {proposed title}
> - **Key points**: {bulleted summary}
>
> Anything to correct or add?"

## Step 4 — Generate Document

Write using appropriate template. Rules:
- `.mdx` extension with YAML frontmatter (`title`, `description`).
- Kebab-case slugs.
- σ prefix: `artifacts/specs/{issue}-{slug}-spec.mdx`
- α/β: `artifacts/analyses/{slug}-analysis.mdx` (prefix with issue# if ∃).
- β adds `type: brainstorm` to frontmatter.
- Escape `<` as `&lt;` in MDX content.

---

## Document Templates

Use templates from [references/templates.md](references/templates.md) — Brainstorm, Analysis, Spec.

$ARGUMENTS