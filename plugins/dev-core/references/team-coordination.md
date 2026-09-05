# Team Coordination Reference

> Extracted from Roxabi boilerplate `AGENTS.md`. Reference copy for dev-core. Canonical here — no upstream `team-coordination.md` exists in the boilerplate repo.

Let: α := agent | μ := micro-task | τ := tier

## Model

Main Claude = orchestrator. Assesses issues, spawns α, runs skills, coordinates workflow. Human approves at every gate.

## Team Structure

| Tier | α | Role |
|------|---|------|
| **Domain** | R-frontend-dev, R-backend-dev, R-devops | Write code in their packages |
| **Quality** | R-fixer, R-tester, R-security-auditor, R-adversarial | Fix findings, write tests, OWASP audit, red-team (`/R-adversarial` skill or review agent) |
| **Strategy** | R-architect, R-product-lead, R-doc-writer | Plan, analyze, document |

## 4-Phase Workflow

1. **Assessment:** Fetch issue → check analysis/spec → spawn R-product-lead (+R-architect) → human approves
2. **Implementation:** Domain α + R-tester. RED → GREEN → REFACTOR → tests pass → PR
3. **Review:** Fresh α from the `/R-dev-review` roster oracle (R-adversarial always; the rest gated by Δ/τ) + `R-finding-verifier` keep/drop pass. Conventional Comments → `/1b1`
4. **Fix & Merge:** R-fixer(s) apply accepted comments → CI → human merges. ≥6 findings spanning distinct modules → multiple R-fixers.

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
- R-backend-dev → R-tester: Files, Routes, Auth, Caveats
- R-frontend-dev → R-tester: Files, Routes consumed, Decisions
- R-architect → R-backend-dev: Decisions, Caveats
- any α → R-fixer: Files, Caveats

## Domain Boundaries

α ¬modify files outside domain.

| α | Owns | ¬Touch |
|---|------|--------|
| R-frontend-dev | `apps/web/`, `packages/ui/` | api, config, docs |
| R-backend-dev | `apps/api/`, `packages/types/` | web, config, docs |
| R-devops | `packages/config/`, root configs, `.github/` | `apps/*/src/`, docs |
| R-fixer | All packages (accepted findings only) | New features |
| R-tester | Test files in all packages | Source files |
| R-security-auditor | Read-only + Bash | Source files |
| R-adversarial | Read-only + Bash (git read-only) | Source files |
| R-architect | `docs/architecture/`, ADRs | App code |
| R-product-lead | `artifacts/analyses/`, `artifacts/specs/`, `gh` CLI | App code |
| R-doc-writer | `docs/`, `CLAUDE.md` | App code |

Intra-domain parallel: multiple same-type α on non-overlapping files OK. Shared files → merge into single α.

## Micro-Task Protocol

When `/R-dev-plan` generates μ, α receive structured work units via TaskCreate.

**Claim:** Spawn-prompt assignment = authoritative. Also check TaskList for unassigned (lowest ID first).

**Verify:** After each μ, check `verificationStatus`:
- `ready` → run cmd now
- `deferred` → GREEN α only after RED-GATE complete. Unexpected deferred → skip verify, continue.
- `manual` → inspect file/code, mark complete

**Fail loop:** verify fails → fix + re-verify (max 3) → 3✗ → escalate to lead (task ID, error, fixes tried, files).

## Spawning Rules

**Parallel:**
- ≥3 complex tasks → present choice: Sequential ∨ Parallel (Recommended)
- F-full + ≥4 independent tasks in 1 domain → multiple same-type α on separate file groups

**RED-GATE:** Sentinel/slice → R-tester (`phase: RED-GATE`). R-tester marks complete after all RED μ done → orchestrator spawns GREEN α.

**Shared α rules:**
- ¬force/hard/amend
- Stage specific files only
- Escalate blockers → lead
- Claim tasks from shared list
- Create follow-up tasks
- Security concerns → lead + R-security-auditor
- Message lead on completion

## Communication

"Message the lead" = concise status in final summary to the parent orchestrator, key info upfront.

- Blocker → lead
- Cross-domain → create task + message lead
- Security → lead + R-security-auditor
- Task handoff via `blockedBy` deps

## Agent Configuration

α behavior via YAML frontmatter in host agent paths (`.claude/agents/*.md` / `.grok/agents/`):
- `maxTurns` (30–50)
- `memory: project` (host agent-memory dir)
- ¬`permissionMode` in plugin agents (Grok ignores bypass; host session controls permissions)

Tool access uses harness defaults unless a project override sets `tools` or `disallowedTools` explicitly.
