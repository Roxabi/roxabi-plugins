# Plan-Task Schema

> **SSoT for `/plan` Step 6a and `/implement` Step 1b.** Both skills must use this exact shape when calling `TaskCreate` for micro-tasks. Edit here only — never inline in either SKILL.md.

## TaskCreate call shape

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
    agent_instance: "{tester-A|backend-dev-B|devops-A|…}",
    subject: "{auth|cache|http|parser|…}",
    spec_trace: "{SC-N or U1→N1→S1}",
    difficulty: {1-5},
    parallel_safe: {true|false},
  },
)
```

## Field notes

| Field | Source |
|-------|--------|
| `kind: "plan-task"` | Fixed — distinguishes from `dev-pipeline` tasks owned by `/dev` |
| `agent_instance` | From the Task Seeding Blueprint row in π — named instance (e.g. `tester-A`) so `/implement` groups tasks per agent session |
| `wave` | Integer derived from the Wave Structure table in π |
| `phase` | RED \| GREEN \| REFACTOR \| RED-GATE — drives test-first ordering in `/implement` Step 4 |
| `spec_trace` | SC-N (Success Criteria) or U→N→S (user/need/solution) reference from the spec artifact |

## Dependencies (TaskUpdate after seeding)

After all `TaskCreate` calls succeed, wire `blockedBy`:

```
∀ micro-task: TaskUpdate(id, addBlockedBy: [deps...])
```

`deps` = T-numbers from the blueprint's `blockedBy` column, mapped to real task IDs via the `{T# → task.id}` cache built during seeding.

Fallback (no blueprint): derive from phase order within a slice — GREEN blocked by RED, RED-GATE blocked by all RED in slice.
