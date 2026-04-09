# implement

Execute the plan — set up a worktree, spawn agents, write code + tests, run the quality gate.

## Why

`/implement` is the execution engine. It reads the plan artifact, creates an isolated git worktree, spawns domain-specific agents (test-first: RED → GREEN → REFACTOR), and gates progress on lint + typecheck + test passing. It does NOT create a PR — that is `/pr`.

## Usage

```
/implement --issue 42             Execute plan for issue #42
/implement --plan path            Execute from an explicit plan file
/implement --issue 42 --audit     Show reasoning checkpoint before coding
```

Triggers: `"implement"` | `"build this"` | `"execute plan"` | `"start coding"` | `"write the code"` | `"ship it"`

## How it works

1. **Locate plan** — reads the plan artifact and attaches to existing Claude Code tasks (or re-seeds if session restarted).
2. **Setup** — creates a worktree at `.claude/worktrees/{N}-{slug}`, checks out a feature branch from base (staging or main), runs `install`.
3. **Context injection** (F-tier) — injects relevant standards docs into each agent's prompt.
4. **Implement**:
   - **Tier S** — lead implements directly, single session, no agent spawning.
   - **Tier F** — spawns agents per plan (test-first): `tester` writes failing tests (RED), domain agents implement to pass (GREEN), agents refactor (REFACTOR), tester verifies coverage.
5. **Quality gate** — runs `lint && typecheck && test`; retries up to 3× with fixer agents; offers abandon on repeated failure.
6. **Summary** — lists created/modified files, agent list, task completion rate, first-try verify pass rate.

## Tier behavior

| Tier | Mode | Agents |
|------|------|--------|
| S | Direct, single session | Lead only |
| F-lite | Sequential subagents | 1–2 domain agents + tester |
| F-full | Parallel agent team | 3+ agents, full RED→GREEN→REFACTOR |

## Chain position

**Predecessor:** `/plan` | **Successor:** `/pr`
