# Harness task list (dual: Claude + Grok)

> **SSoT for portable task-list ops.** Skills speak **generic** vocabulary; this file maps to host tools.  
> Prefer **one skill body + capability branch** — never fork full SKILL.md per host.

## Principle

| Layer | Rule |
|-------|------|
| Skill prose | Host-neutral: « seed task list », « claim task », « mark done », « wire deps » |
| Capability probe | Detect which tools exist **in this session** (schema / known names) |
| Rich path | Full graph (deps, metadata, re-attach) when host supports it |
| Portable path | Flat checklist when host only has a simple TODO API |
| Artifact | Plan file remains **cross-session SSoT**; host task list is **in-session only** |

## Capability matrix

| Operation (generic) | Claude Code | Grok | Notes |
|---------------------|-------------|------|-------|
| Seed N tasks | `TaskCreate` × N | `todo_write` (batch merge) | Grok: no per-task return ID graph |
| Attach metadata | `TaskCreate.metadata` | encode in `content` line | Keep blueprint fields in text |
| Wire dependencies | `TaskUpdate` + `blockedBy` | **not supported** | Enforce order in skill prose + blueprint only |
| List open tasks | `TaskList` | read current todos (tool state) | Grok: model already sees todo list |
| Get one task | `TaskGet` | N/A — use list | — |
| Mark done | `TaskUpdate` status | `todo_write` status=`completed` | — |
| Re-attach after restart | blueprint in π + `TaskCreate` | re-seed from blueprint → `todo_write` | Both: artifact wins across sessions |

## Detection (orchestrator)

```
if tools ∋ TaskCreate ∧ TaskUpdate ∧ TaskList → H := claude-tasks
else if tools ∋ todo_write → H := grok-todos
else → H := artifact-only   # plan file only; no in-session list
```

¬probe by OS name. Probe **tools available in the current harness**.

## Seed procedure (generic)

Input: Task Seeding Blueprint from π (see `plan-task-schema.md`).

### H = claude-tasks (rich)

1. ∀ row → `TaskCreate` with shape in `plan-task-schema.md`
2. Cache `{T# → task.id}`
3. `TaskUpdate` deps from blueprint `blockedBy`
4. Persist id map in π if skill requires re-attach

### H = grok-todos (portable)

1. Build one `todo_write` batch (merge=false on first seed, merge=true on resume):
   - `id`: stable `T{n}` from blueprint (not random)
   - `content`: `[{phase}] {agent_instance} — {subject} | Verify: {cmd} | {spec_trace}`
   - `status`: `pending`
2. **Deps:** do not invent blockedBy. Orchestrator only spawns/claims a task when all blueprint deps are `completed` (or no deps).
3. Persist nothing host-side across sessions — re-read blueprint from π.

### H = artifact-only

Work only from π micro-tasks table. Present progress in the reply. No host list.

## Claim / execute (generic)

1. Pick next ready task (deps satisfied, not completed)
2. Inject description into agent spawn prompt
3. On success → mark completed
4. On fail → leave pending / note blocker; ¬auto-complete

## Anti-patterns

| Don’t | Do |
|-------|----|
| Fork `plan/SKILL.md` into claude vs grok copies | One skill + this mapping |
| Require `TaskCreate` on Grok | Branch to `todo_write` |
| Assume `blockedBy` on Grok | Enforce order in orchestrator |
| Treat host todos as durable | Artifact π is durable |

## Consumers

| Skill | Uses H for |
|-------|------------|
| `/dev-plan` Step 6a | Initial seed |
| `/implement` Step 1b | Attach / re-seed / probe once |
| `/implement` Step 4 | Claim, load context, mark done, ready-set |
| `/implement` Step 6 | All-completed assert |

## Related

- Call shape (rich path): [`plan-task-schema.md`](plan-task-schema.md)
- Worktree dual-harness (principal freeze + H_wt): [`harness-worktree.md`](harness-worktree.md)
- Dual harness install notes: `dev-init` skill « Dual harness »
