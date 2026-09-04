# dev-plan

Implementation plan — micro-tasks, agent assignments, file groups, and dependency graph.

## Why

A spec says *what* to build. A plan says *who builds what, in what order, in parallel where safe*. `/R-dev-plan` decomposes the spec into micro-tasks with verify commands, assigns them to domain agents, wires RED→GREEN→REFACTOR phase dependencies, and seeds the **host task list** (Claude `Task*` or Grok `todo_write`) — giving `/R-dev-implement` a ready-to-execute work queue.

## Usage

```
/R-dev-plan --issue 42             Generate plan for issue #42
/R-dev-plan --spec path            Generate plan from an explicit spec file
/R-dev-plan --issue 42 --audit     Show reasoning checkpoint as prose, then continue
```

Triggers: `"plan"` | `"plan this"` | `"implementation plan"` | `"break it down"` | `"make a plan"` | `"task breakdown"`

## How it works

**HITL: chat-native (¬AskUserQuestion).** Continuous pipeline + **one** approval stop (Executive Summary). Auto when path is unique (slice, budget splits).

1. **Locate spec** — reads the spec; leftover `[NEEDS CLARIFICATION]` → χ in summary (prose stop only if unusable).
2. **Scope + agents + tasks** — continuous (no mid-plan approve). Budget overruns force-split automatically. Multi-slice: auto next unimplemented when clear; else default + χ.
3. **Micro-tasks** — description, file, skeleton, verify, phase (RED/GREEN/REFACTOR/RED-GATE), agent instances.
4. **Write artifact** — `artifacts/plans/{N}-{slug}-plan.md` (markdown architecture section).
5. **Executive Summary** — delivery + gates; free-form `approve` / `modify …` / `return to spec` / `adversarial` / `advisory`.
6. **On approve — seed tasks** — host task list + persist `## Task IDs`, then commit.

## Output artifact

```
artifacts/plans/{N}-{slug}-plan.md
```

## Chain position

**Predecessor:** `/R-spec` | **Successor:** `/R-dev-implement` (via a compact pause after approval — `/R-dev` recommends `/compact` before building, then `/R-dev #N` ≡ `/R-dev-implement #N`)

Class: `adv + approval stop`. Disk done-signal = `## Task IDs` (written only after free-form approve).
