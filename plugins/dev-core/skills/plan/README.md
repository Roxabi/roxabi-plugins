# plan

Implementation plan — micro-tasks, agent assignments, file groups, and dependency graph.

## Why

A spec says *what* to build. A plan says *who builds what, in what order, in parallel where safe*. `/plan` decomposes the spec into micro-tasks with verify commands, assigns them to domain agents, wires RED→GREEN→REFACTOR phase dependencies, and seeds the **host task list** (Claude `Task*` or Grok `todo_write`) — giving `/implement` a ready-to-execute work queue.

## Usage

```
/plan --issue 42             Generate plan for issue #42
/plan --spec path            Generate plan from an explicit spec file
/plan --issue 42 --audit     Show reasoning checkpoint before planning
```

Triggers: `"plan"` | `"plan this"` | `"implementation plan"` | `"break it down"` | `"make a plan"` | `"task breakdown"`

## How it works

**AQ policy:** continuous pipeline + **one** approval gate (Step 6). Auto when path is unique (slice, budget splits). `/spec` remains chat-native HITL (exec summary) — this skill does not weaken that.

1. **Locate spec** — reads the spec; if leftover `[NEEDS CLARIFICATION]` → AQ; else silent.
2. **Scope + agents + tasks** — continuous (no mid-plan Approve). Budget overruns force-split automatically. Multi-slice: auto next unimplemented when clear.
3. **Micro-tasks** — description, file, skeleton, verify, phase (RED/GREEN/REFACTOR/RED-GATE), agent instances.
4. **Write artifact** — `artifacts/plans/{N}-{slug}-plan.md` + forge-chart sidecars (`data-flow`, `file-map`).
5. **Approve (sole gate)** — Approve | Modify | Return to spec.
6. **Seed tasks** — host task list (Claude `Task*` / Grok `todo_write`) + persist blueprint / `## Task IDs`, then commit.

## Output artifact

```
artifacts/plans/{N}-{slug}-plan.md
```

## Chain position

**Predecessor:** `/spec` | **Successor:** `/implement` (via a compact pause after approval — `/dev` recommends `/compact` before building, then `/dev #N` ≡ `/implement #N`)
