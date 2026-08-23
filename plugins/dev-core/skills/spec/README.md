# spec

Solution spec — acceptance criteria, breadboard (UI/API wiring), and vertical slices.

## Why

A spec translates the chosen architectural shape into something implementable: binary acceptance criteria, a wiring diagram of UI/API affordances, and independently demo-able vertical slices. Without it, agents implementing the feature have no shared definition of done.

## Usage

```
/spec --issue 42            Generate spec from analysis for issue #42
/spec --analysis path       Use an explicit analysis file as source
/spec --frame path          Use a frame directly (analysis was skipped)
/spec --issue 42 --audit    Show reasoning checkpoint (prose) then write
```

Triggers: `"write spec"` | `"spec this"` | `"solution design"` | `"acceptance criteria"` | `"define acceptance criteria"`

## How it works

**No AskUserQuestion.** Human-in-the-loop is chat-native: full draft → **Executive Summary** → free-form reply.

1. **Resolve source** — analysis or frame (if F-lite); kind read from frontmatter, not the filename. Stop with prose if missing.
2. **Generate** — promote SRC → σ without interactive `/interview` AQs; unknowns become `[NEEDS CLARIFICATION]`.
3. **Pre-check** — binary criteria, breadboard refs, χ budget, slice coverage; auto-fix cheap issues.
4. **Expert review** — architect, doc-writer, product-lead, adversarial (devops/axial when relevant) in parallel.
5. **Executive Summary (lean)** — Intent (Solve + Done when) → Scope → Delivery → Gates; ≤30s scan; hard caps (≤5 criteria, ≤4 In bullets) — then **stop**.
6. **React** — natural language: approve · change X · questions · re-spec · split. Revise loops re-print the summary.

## Output artifact

```
artifacts/specs/{N}-{slug}-spec.md
```

Frontmatter on write: `title` (yaml-escaped), `description`, `type: spec`, `status: draft`. Approval flips `status` to `approved`. Contract: [artifact-frontmatter.md](../shared/references/artifact-frontmatter.md).

Sections: Context, **Intent** (what we solve), Goal (done-when), Users, Expected Behavior, Data Model & Consumers (markdown prose + optional consumer table — no HTML sidecars), Breadboard, Slices, Success Criteria.

Fail-closed / security / guard SCs must declare a **priced quantity** block (`priced` / `not` / `oracles`). Implementer and tester test `priced` + `oracles`, never the `not` proxy.

## Chain position

**Predecessor:** `/analyze` (F-full) or `/frame` (F-lite) | **Successor:** `/dev-plan` (after free-form approve)
