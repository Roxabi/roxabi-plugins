# spec

Solution spec — acceptance criteria, breadboard (UI/API wiring), and vertical slices.

## Why

A spec translates the chosen architectural shape into something implementable: binary acceptance criteria, a wiring diagram of UI/API affordances, and independently demo-able vertical slices. Without it, agents implementing the feature have no shared definition of done.

## Usage

```
/spec --issue 42            Generate spec from analysis for issue #42
/spec --analysis path       Use an explicit analysis file as source
/spec --frame path          Use a frame directly (analysis was skipped)
/spec --issue 42 --audit    Show reasoning checkpoint before writing
```

Triggers: `"write spec"` | `"spec this"` | `"solution design"` | `"acceptance criteria"` | `"define acceptance criteria"`

## How it works

1. **Resolve source** — finds the analysis (or frame if F-lite) for the issue.
2. **Generate** — runs a structured interview (via `/interview`) to fill gaps between analysis and spec level: acceptance criteria, breadboard, slices, ambiguity detection.
3. **Pre-check** — validates the spec before expert review: testable criteria (binary pass/fail), no dangling breadboard refs, ≤5 `[NEEDS CLARIFICATION]` items, slice coverage of all affordances.
4. **Expert review** — spawns architect, doc-writer, product-lead (and devops if infra criteria) in parallel.
5. **Smart splitting** (optional) — if > 8 acceptance criteria or > 3 slices, offers to split into sub-issues.
6. **User approval** — presents scope, criteria count, unresolved concerns; loops on revisions.

## Output artifact

```
artifacts/specs/{N}-{slug}-spec.mdx
```

Sections: Context, Goal, Users, Expected Behavior, Data Model & Consumers (mermaid), Breadboard, Slices, Success Criteria.

## Chain position

**Predecessor:** `/analyze` (F-full) or `/frame` (F-lite) | **Successor:** `/plan`
