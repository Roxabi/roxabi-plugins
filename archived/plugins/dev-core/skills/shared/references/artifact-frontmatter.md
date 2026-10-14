# Artifact Frontmatter Contract

SSoT for every skill that **writes** a pipeline or exploration artifact. Readers (`scan-state.sh`, `artifact-classify.ts`, `/R-dev`, `/R-spec` SRC resolution) depend on these keys. If a writer omits them, a later parser invents behaviour.

## Title hygiene

`{title}` is **external content** — typically a GitHub issue title, controlled by anyone who can open an issue on the repo. Before any use in YAML, commit messages, or shell:

1. Strip newlines and other control characters.
2. Cap at 120 characters.
3. Emit as a **single-line double-quoted YAML scalar** with `"` and `\` escaped.

Template form: `title: "{title|yaml-escaped}"`.

**Why.** An injected newline adds a frontmatter key. `status:` is the pipeline gate signal (`/R-dev` reads it via `scan-state.sh --classify-artifact`). A first-match parser can take an injected key over the real one; even a last-wins parser still corrupts the document. Commit subjects that interpolate a raw title allow `$(…)` / backtick execution — use the already-sanitized `{slug}` for commit messages instead.

Same hygiene applies to any other user/issue-controlled string that lands in YAML (`description` when it is free-form).

## Required keys on write

| Kind | `type:` | `status:` on write | On approve | Directory |
|------|---------|-------------------|------------|-----------|
| Frame | — | `draft` | `approved` | `artifacts/frames/` |
| Brainstorm | `brainstorm` | `draft` | — (no pipeline gate) | `artifacts/brainstorms/` |
| Analysis | `analysis` | `draft` | `approved` | `artifacts/analyses/` |
| Spec | `spec` | `draft` | `approved` | `artifacts/specs/` |
| Plan | — | — (approved by commit gate) | — | `artifacts/plans/` |
| Adversarial / Advisory | — | `review-complete` | — | `artifacts/reviews/` |

**Rules:**

1. **Gate artifacts** (frame, analysis, spec) always write `status: draft`. Approval flips to `approved` via Edit — never write `approved` on first generate. `/R-dev` treats missing `status` as legacy-approved; an aborted draft without `status: draft` falsely completes the phase.
2. **`type:`** is mandatory for any kind that can share a directory with another kind (historical or by mistake). Analyses and brainstorms both lived under `artifacts/analyses/` before 2026-08-03; classifiers still read `type:` so legacy files resolve correctly. New brainstorms go to `artifacts/brainstorms/` — keep emitting `type: brainstorm` as belt-and-braces.
3. **One kind per directory for new writes.** β → `brainstorms/`, α → `analyses/`, σ → `specs/`. Do not re-open the shared-directory problem.
4. **Classify on frontmatter, ¬filename.** Naming has ≥4 live forms (`{N}-{slug}-analysis.md`, bare slug, `-iterN`, `.claude.md`, `.mdx`). Filename filters are not a substitute for `type:`/`status:`.

## Minimal skeletons

### Analysis (`/R-analyze`, `/R-interview` τ=α)

```md
---
title: "{title|yaml-escaped}"
description: "{one-line description}"
type: analysis
status: draft
---
```

### Spec (`/R-spec`, `/R-interview` τ=σ)

```md
---
title: "{title|yaml-escaped}"
description: "{one-line description}"
type: spec
status: draft
---
```

### Brainstorm (`/R-interview` τ=β)

```md
---
title: "{title|yaml-escaped}"
description: "{one-line description}"
type: brainstorm
status: draft
---
```

### Frame (`/R-frame`)

```md
---
title: "{title|yaml-escaped}"
issue: {N | null}
status: draft
tier: {τ}
date: {YYYY-MM-DD}
---
```

## Readers (do not re-implement)

| Consumer | What it reads |
|----------|----------------|
| `artifact-classify.ts` (via `lib.sh`) | fence → `type:` / `status:` → kind |
| `dev/scan-state.sh` | `resolve_analysis` + `analyze_status` for Σ |
| `pr/gather-state.sh` | same resolver as `/R-dev` |
| `/R-analyze` Step 1, `/R-spec` Step 0 | kind + status for reuse / STOP |

Extend the TS classifier when adding a new `type:` value that must be excluded from α resolution. Do not add a second bash parser.
