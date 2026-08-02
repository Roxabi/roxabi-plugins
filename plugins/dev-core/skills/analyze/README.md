# analyze

Deep technical analysis — explore existing code, identify risks, and shape 2–3 mutually exclusive architectural approaches.

## Why

For complex issues (F-full tier), jumping from frame to spec skips the most important question: *how could we build this?* `/analyze` does codebase exploration, structured interview, and expert review to produce an analysis artifact with concrete architectural shapes and a fit-check against constraints.

## Usage

```
/analyze --issue 42       Analyze issue #42 (reads its frame artifact)
/analyze --frame path     Analyze from an explicit frame file
```

Triggers: `"analyze"` | `"technical analysis"` | `"deep dive"` | `"explore the problem"` | `"investigate this"` | `"what are the risks"`

## How it works

1. **Resolve input** — locates the frame artifact for the issue.
2. **Codebase exploration** — Globs and Greps relevant files; reads up to 8 key files to understand paths, patterns, and dependencies.
3. **Interview** — structured interview (via `/interview` skill) to capture: source trigger, problem, desired outcome, appetite/time budget, and 2–3 architectural shapes with trade-offs.
4. **Investigation spike** (optional) — if an unknown blocks shape selection (undocumented APIs, performance unknowns), creates a throwaway worktree to test the hypothesis, then cleans up. Non-blocking unknowns are carried as χ into the summary instead.
5. **Expert review** — spawns domain experts in parallel: `doc-writer` (structure), `product-lead` (fit), `architect` (soundness), `devops` (if infra changes).
6. **Executive Summary (lean)** — Intent (Solve + Done when + Appetite) → Options table → Recommendation → Gates; ≤30s scan; hard caps (≤3 shapes, ≤3 χ, ≤3 expert notes) — then **stop**.
7. **React** — natural language: approve · shape 2 / change X · questions · spike X · re-analyze. Revise loops re-print the summary.

## Output artifact

```
artifacts/analyses/{N}-{slug}-analysis.md
```

Sections: Source, **Problem** (what we solve), **Outcome** (done-when), Appetite, Shapes (2–3), Fit Check. Architecture visuals are forge-chart sidecars in `artifacts/visuals/` (linked from Shapes / Fit Check — not inline mermaid).

Human-in-the-loop is **chat-native** — no AskUserQuestion menus. The summary is the gate; you reply in free text.

## Chain position

**Predecessor:** `/frame` | **Successor:** `/spec`
