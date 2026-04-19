# Team Coordination Reference

> Extracted from Roxabi boilerplate `AGENTS.md`. Reference copy for dev-core. Canonical source in boilerplate repo.

Let: α := agent | μ := micro-task | τ := tier

## Model

Main Claude = orchestrator. Assesses issues, spawns α, runs skills, coordinates workflow. Human approves at every gate.

## Team Structure

| Tier | α | Role |
|------|---|------|
| **Domain** | frontend-dev, backend-dev, devops | Write code in their packages |
| **Quality** | fixer, tester, security-auditor | Fix findings, write tests, audit |
| **Strategy** | architect, product-lead, doc-writer | Plan, analyze, document |

## 4-Phase Workflow

1. **Assessment:** Fetch issue → check analysis/spec → spawn product-lead (+architect) → human approves
2. **Implementation:** Domain α + tester. RED → GREEN → REFACTOR → tests pass → PR
3. **Review:** Fresh α (security, architect, product, tester + domain). Conventional Comments → `/1b1`
4. **Fix & Merge:** Fixer(s) apply accepted comments → CI → human merges. ≥6 findings spanning distinct modules → multiple fixers.

## Task Lifecycle

Lead creates tasks → α claim by domain → execute → mark complete + follow-ups → human reviews at gates.

## Handoff Format

On task completion feeding another α, include structured handoff to lead:

```
Handoff: <short description>
  Files: <files created/modified, one per line>
  Migrations: <DB migration files, if any>
  Routes: <new/changed API routes, if any>
  Types: <new/changed shared types in @repo/types, if any>
  Auth: <auth requirements for new endpoints>
  Decisions: <key choices made and why>
  Caveats: <known limitations, TODOs, or risks>
  Depends on: <task IDs this work depends on>
```

Omit empty fields. Lead forwards relevant sections to next α spawn prompt.

**Examples:**
- backend-dev → tester: Files, Routes, Auth, Caveats
- frontend-dev → tester: Files, Routes consumed, Decisions
- architect → backend-dev: Decisions, Caveats
- any α → fixer: Files, Caveats

## Domain Boundaries

α ¬modify files outside domain.

| α | Owns | ¬Touch |
|---|------|--------|
| frontend-dev | `apps/web/`, `packages/ui/` | api, config, docs |
| backend-dev | `apps/api/`, `packages/types/` | web, config, docs |
| devops | `packages/config/`, root configs, `.github/` | `apps/*/src/`, docs |
| fixer | All packages (accepted findings only) | New features |
| tester | Test files in all packages | Source files |
| security-auditor | Read-only + Bash | Source files |
| architect | `docs/architecture/`, ADRs | App code |
| product-lead | `artifacts/analyses/`, `artifacts/specs/`, `gh` CLI | App code |
| doc-writer | `docs/`, `CLAUDE.md` | App code |

Intra-domain parallel: multiple same-type α on non-overlapping files OK. Shared files → merge into single α.

## Micro-Task Protocol

When `/plan` generates μ, α receive structured work units via TaskCreate.

**Claim:** Spawn-prompt assignment = authoritative. Also check TaskList for unassigned (lowest ID first).

**Verify:** After each μ, check `verificationStatus`:
- `ready` → run cmd now
- `deferred` → GREEN α only after RED-GATE complete. Unexpected deferred → skip verify, continue.
- `manual` → inspect file/code, mark complete

**Fail loop:** verify fails → fix + re-verify (max 3) → 3✗ → escalate to lead (task ID, error, fixes tried, files).

## Spawning Rules

**Parallel:**
- ≥3 complex tasks → → DP(A): Sequential ∨ Parallel (Recommended)
- F-full + ≥4 independent tasks in 1 domain → multiple same-type α on separate file groups

**RED-GATE:** Sentinel/slice → tester (`phase: RED-GATE`). Tester marks complete after all RED μ done → orchestrator spawns GREEN α.

**Shared α rules:**
- ¬force/hard/amend
- Stage specific files only
- Escalate blockers → lead
- Claim tasks from shared list
- Create follow-up tasks
- Security concerns → lead + security-auditor
- Message lead on completion

## Communication

"Message the lead" = `SendMessage` w/ concise status, key info upfront.

- Blocker → lead
- Cross-domain → create task + message lead
- Security → lead + security-auditor
- Task handoff via `blockedBy` deps

## Agent Configuration

α behavior via YAML frontmatter in `.claude/agents/*.md`:
- `permissionMode` (bypassPermissions | plan)
- `maxTurns` (30–50)
- `memory: project` (.claude/agent-memory/)
- `skills` (preloaded)
- `disallowedTools` (deny list)
