# Plan Edge Cases

| Scenario | Behavior |
|----------|----------|
| No spec found | Suggest `/spec` or `/dev`. Stop. |
| Unresolved `[NEEDS CLARIFICATION]` | Pre-flight warns. User: resolve ∨ return to spec ∨ proceed |
| No Breadboard ∧ no Success Criteria | Skip micro-tasks, warn, use text tasks from Step 2d |
| Task count > 30 | Warn, show full list, suggest splitting |
| Multi-slice spec | Step 2e: select slices. Default 1/run. Re-run `/plan` for rest. |
| All slices implemented | Detect via code/tests. Suggest `/review`. |
| Consistency 0 coverage | Block agents. Return to spec ∨ regenerate. |
| Affordance > 5 min | Split into 2-3 sub-tasks |
| Session interrupted after plan commit | Resume: re-read plan, reconstruct TaskCreate, skip consistency |
| User wants to regenerate tasks | New commit (¬amend). Latest plan = authoritative. |
| `artifacts/plans/` dir missing | Create on first use (Step 5) |
