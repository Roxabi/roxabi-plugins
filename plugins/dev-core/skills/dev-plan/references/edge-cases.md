# Plan Edge Cases

| Scenario | Behavior |
|----------|----------|
| No spec found | Suggest `/spec` or `/dev`. Stop. |
| Unresolved `[NEEDS CLARIFICATION]` | ¬AQ — list χ in Executive Summary; prose stop only if planning unusable; free-form: resolve / return to spec / proceed anyway |
| No Breadboard ∧ no Success Criteria | Skip micro-tasks, warn, use text tasks from Step 2d |
| Task count > 30 | Warn + full list; ¬AQ; modify via free text at Step 6/7 |
| Multi-slice spec | Step 2e: auto next unimplemented when unique; else default first parallel root + χ in summary. 1 slice/run default. Re-run `/dev-plan` for rest. |
| Mid-plan double approve | Forbidden — sole gate is Step 6 Executive Summary + free-form (2f removed) |
| All slices implemented | Detect via code/tests. Suggest `/dev-review`. |
| Consistency 0 coverage | Block agents. Return to spec ∨ regenerate. |
| Affordance > 5 min | Split into 2-3 sub-tasks |
| Session interrupted after plan commit | Resume: re-read plan, reconstruct TaskCreate, skip consistency |
| User wants to regenerate tasks | New commit (¬amend). Latest plan = authoritative. |
| `artifacts/plans/` dir missing | Create on first use (Step 5) |
