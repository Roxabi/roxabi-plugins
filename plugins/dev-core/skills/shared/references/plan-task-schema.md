# Plan-Task Schema

> **SSoT for `/R-dev-plan` Step 6a and `/R-dev-implement` Step 1b.** Host-neutral fields + rich-path shape.  
> **How to call the host:** see [`harness-task-list.md`](harness-task-list.md) (Claude `Task*` vs Grok `todo_write`).  
> Edit field definitions here only — never inline in either SKILL.md.

## Canonical fields (every host)

| Field | Source |
|-------|--------|
| `kind: "plan-task"` | Fixed — distinguishes from `dev-pipeline` tasks owned by `/R-dev` |
| `agent_instance` | From the Task Seeding Blueprint row in π — named instance (e.g. `R-tester-A`) so `/R-dev-implement` groups tasks per agent session |
| `wave` | Integer derived from the Wave Structure table in π |
| `phase` | RED \| GREEN \| REFACTOR \| RED-GATE — drives test-first ordering in `/R-dev-implement` Step 4 |
| `spec_trace` | SC-N (Success Criteria) or U→N→S (user/need/solution) reference from the spec artifact |
| `subject` / `verify` / `files` | Blueprint + micro-task row |

## Rich path — TaskCreate call shape (H = claude-tasks)

```
TaskCreate(
  subject: "{task description}",
  description: "{files}\n\nVerify: {verify_command}\nExpected: {expected_output}\nRef: {pattern_file}\nSpec trace: {spec_trace}",
  activeForm: "{present-continuous form}",
  metadata: {
    kind: "plan-task",
    issue: N,
    plan: "{path to π}",
    slice: "V{n}",
    wave: {wave number},
    phase: "RED|GREEN|REFACTOR|RED-GATE",
    agent: "{agent type}",
    agent_instance: "{R-tester-A|R-backend-dev-B|R-devops-A|…}",
    subject: "{auth|cache|http|parser|…}",
    spec_trace: "{SC-N or U1→N1→S1}",
    difficulty: {1-5},
    parallel_safe: {true|false},
  },
)
```

### Dependencies (rich path only)

After all `TaskCreate` calls succeed, wire `blockedBy`:

```
∀ micro-task: TaskUpdate(id, addBlockedBy: [deps...])
```

`deps` = T-numbers from the blueprint's `blockedBy` column, mapped to real task IDs via the `{T# → task.id}` cache built during seeding.

Fallback (no blueprint): derive from phase order within a slice — GREEN blocked by RED, RED-GATE blocked by all RED in slice.

## Portable path — todo_write (H = grok-todos)

See `harness-task-list.md`. Encode the same fields in `content`; use stable `id: T{n}`; enforce `blockedBy` in the orchestrator (host has no dep graph).
