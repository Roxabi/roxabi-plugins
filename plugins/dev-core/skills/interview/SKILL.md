---
name: interview
argument-hint: [topic | --promote <path>]
description: Structured interview → brainstorm | analysis | spec (with promotion). Triggers: "interview" | "brainstorm" | "let's brainstorm" | "think through this" | "help me brainstorm" | "let's think this through" | "explore ideas".
version: 0.2.3
allowed-tools: Write, Read, Edit, Glob, ToolSearch
---

# Interview

Let:
  β := Brainstorm | α := Analysis | σ := Spec
  τ := document type ∈ {β, α, σ}
  B := `artifacts/brainstorms/` | A := `artifacts/analyses/` | S := `artifacts/specs/`
  AQ := present choice, wait for user reply

Conduct structured interview → produce one of {β, α, σ}. Supports promoting existing doc to next level.

## Step 0 — Check `--promote`

∃ `--promote <path>`:
1. Read doc at path.
2. Determine current τ (frontmatter first, content structure fallback):
   - `type: brainstorm` ∈ frontmatter ∨ lives in B → β → promote to α.
   - `type: analysis` ∈ frontmatter → α → promote to σ.
   - `type: spec` ∈ frontmatter ∨ lives in S → already σ → inform: "Already a spec. Nothing to promote." Stop.
   - ¬type ∧ lives in A ∧ "Trigger"/"Ideas" structure → treat as β (legacy: β lived in A before 2026-08-03).
   - A path ∧ "Questions Explored"/"Analysis"/"Conclusions" structure → α → promote to σ.
   - Already σ (structure) → inform: "Already a spec. Nothing to promote." Stop.
3. Skip to Step 2; limit questions to gaps between current doc and next level. Pre-fill known from source.
4. In promoted doc's Context: `**Promoted from:** [source title](relative-path-to-source)`

¬`--promote` → Step 1.

## Step 1 — Existing Document Awareness

Glob B, A, S — match topic by issue#, keywords, or slug. **B included**: β moved out of A on 2026-08-03, and without it a second `/interview` on the same topic cannot see the brainstorm it wrote itself → duplicate β instead of the promote gate below.

∃ related docs → AQ:
> "Found existing documents: {list with paths}. How to proceed?"
- **Build on existing** — use as context, extend
- **Promote to next level** — α → σ or β → α
- **Start fresh** — ignore, begin new interview

¬related → Step 2.

## Step 2 — Determine Document Type

∃ `--promote` → skip (already determined). Else AQ:

| τ | Purpose | Output Path |
|---|---------|-------------|
| β | Divergent exploration, early-stage ideas | `artifacts/brainstorms/{slug}-brainstorm.md` |
| α | Structured investigation of topic/problem | `artifacts/analyses/{slug}-analysis.md` |
| σ | Technical specification for implementation | `artifacts/specs/{issue}-{slug}-spec.md` |

**One kind per directory.** β never lands in A: `/dev`, `/spec` and `/analyze` resolve α by scanning A, and a brainstorm sitting there is indistinguishable by filename — it has to be excluded by reading frontmatter at every consumer. Writing it elsewhere removes the need to classify at all.

## Step 3 — Structured Interview

AQ per phase. Group 2–4 questions/call. Skip questions obvious from context, arguments, or source doc.

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

∀ ambiguity: rank by **Impact × Uncertainty** (H/M/L). H×H → follow-up question. Unresolved → `[NEEDS CLARIFICATION: description]` (max 3–5/spec). Must resolve before `/dev-plan`.

Depth by τ: β = Phase 1 + divergent (lighter) | α = Phases 1–3 thorough | σ = all phases, rigorous on edge cases + criteria.

#### Phase 4 — Validation (1 question, always last)

> "My understanding before generating:
> - **Type**: {τ}
> - **Title**: {proposed title}
> - **Key points**: {bulleted summary}
>
> Anything to correct or add?"

## Step 4 — Generate Document

Write using the matching template. **Frontmatter is not optional** — full contract: [artifact-frontmatter.md](${CLAUDE_PLUGIN_ROOT}/skills/shared-refs/artifact-frontmatter.md).

Rules:
- `.md` extension; kebab-case slugs.
- **Title hygiene** on every `title:` / free-form `description:` (external content — strip control chars, cap 120, double-quoted YAML with `"`/`\` escaped). Form: `"{title|yaml-escaped}"`.
- Required keys on write (always `status: draft` for new docs):

| τ | Path | Frontmatter must include |
|---|------|--------------------------|
| β | `artifacts/brainstorms/{slug}-brainstorm.md` (prefix issue# if ∃) — **¬in A** | `type: brainstorm`, `status: draft` |
| α | `artifacts/analyses/{slug}-analysis.md` (prefix issue# if ∃) | `type: analysis`, `status: draft` |
| σ | `artifacts/specs/{issue}-{slug}-spec.md` | `type: spec`, `status: draft` |

`type:` is how classifiers distinguish kinds when legacy files still share a directory; `status: draft` prevents `/dev` from treating an unfinished α/σ as approved (missing `status` ≡ legacy-approved).

---

## Document Templates

Use templates from [references/templates.md](${CLAUDE_SKILL_DIR}/references/templates.md) — Brainstorm, Analysis, Spec. Each template's frontmatter already carries `type:` + `status:` — do not strip them.

$ARGUMENTS
