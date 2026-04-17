# plan

Implementation plan — micro-tasks, agent assignments, file groups, and dependency graph.

## Why

A spec says *what* to build. A plan says *who builds what, in what order, in parallel where safe*. `/plan` decomposes the spec into micro-tasks with verify commands, assigns them to domain agents, wires RED→GREEN→REFACTOR phase dependencies, and seeds the Claude Code task list — giving `/implement` a ready-to-execute work queue.

## Usage

```
/plan --issue 42             Generate plan for issue #42
/plan --spec path            Generate plan from an explicit spec file
/plan --issue 42 --audit     Show reasoning checkpoint before planning
```

Triggers: `"plan"` | `"plan this"` | `"implementation plan"` | `"break it down"` | `"make a plan"` | `"task breakdown"`

## How it works

1. **Locate spec** — reads the spec artifact; checks for unresolved `[NEEDS CLARIFICATION]` items.
2. **Scope** — Globs + Greps the codebase to identify files to create/modify; finds reference patterns.
3. **Agents** — assigns tasks to: `frontend-dev`, `backend-dev`, `tester`, `devops`, `doc-writer`, `architect`, `security-auditor` based on file paths from `stack.yml`.
4. **Micro-tasks** — generates tasks with: description, file path, code skeleton, verify command, expected output, time estimate, parallel-safe flag, phase (RED/GREEN/REFACTOR/RED-GATE).
5. **Write artifact** — creates `artifacts/plans/{N}-{slug}-plan.mdx` with mermaid data-flow and file×function diagrams.
6. **Seed tasks** — creates Claude Code tasks for every micro-task; wires `blockedBy` dependencies; persists task IDs in the artifact.

## Output artifact

```
artifacts/plans/{N}-{slug}-plan.mdx
```

## Chain position

**Predecessor:** `/spec` | **Successor:** `/implement` (auto-chains after approval)
