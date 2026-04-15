# Dev Process Reference

> Extracted from Roxabi boilerplate `CLAUDE.md`. Reference copy for dev-core. Canonical source in boilerplate repo.

Let: τ := tier | α := agent

## Tier System

`/dev #N` determines τ based on complexity:

| τ | Criteria | Phases |
|---|----------|--------|
| **S** | ≤3 files, no arch, no risk | triage → implement → pr → validate → review → fix* → promote* → cleanup* |
| **F-lite** | Clear scope, single domain | Frame → spec → plan → implement → verify → ship |
| **F-full** | New arch, unclear reqs, >2 domains | Frame → analyze → spec → plan → implement → verify → ship |

`*` = conditional (runs only if applicable)

## Workflow Phases

Flow: **Frame** (problem) → **Shape** (spec) → **Build** (code) → **Verify** (review) → **Ship** (release).

- **Frame:** Define problem space. Create feature frame from GitHub issue.
- **Shape:** Deep analysis (F-full only), spec, reqs gathering. Specs w/ smart splitting.
- **Build:** Impl plan w/ micro-tasks, code execution, PR creation.
- **Verify:** Code review vs quality gates, fix application, spec validation.
- **Ship:** Post-merge cleanup, promotion to staging/prod.

## Artifact Model

Artifacts = state markers for `/dev` progress detection + resumption.

| Type | Directory | Question |
|------|-----------|----------|
| **Frame** | `artifacts/frames/` | What's the problem? |
| **Analysis** | `artifacts/analyses/` | How deep? |
| **Spec** | `artifacts/specs/` | What to build? |
| **Plan** | `artifacts/plans/` | How to build? |

`/dev` scans these dirs → determine progress → resume from correct phase.

## Git Workflow Rules

### Worktree

All code changes require worktree:

```bash
git worktree add ../roxabi-XXX -b feat/XXX-slug staging
cd ../roxabi-XXX && cp .env.example .env && bun install
cd apps/api && bun run db:branch:create --force XXX
```

**Exceptions:** XS issues (confirm via AskUserQuestion), `/dev` pre-impl artifacts (frame, analysis, spec, plan), `/promote` release artifacts.

¬code on main/staging w/o worktree.

### Commit Format

```
<type>(<scope>): <desc>
```

Followed by: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`

Types: `feat` | `fix` | `refactor` | `docs` | `style` | `test` | `chore` | `ci` | `perf`

### Branch Naming

`feat/XXX-slug` where XXX = issue number.

## Quality Gate Requirements

- Code review uses Conventional Comments
- Block only on: security, correctness, standard violations
- Must read code-review standards before reviewing
- CI must pass before merge
- Human approves at every gate

## Mandatory Rules

1. **AskUserQuestion:** Always for decisions, choices (≥2 options), approach proposals. ¬plain-text questions.
2. **¬force/amend:** ¬`--force`, ¬`--hard`, ¬`--amend`. Hook fail → fix + NEW commit.
3. **Orchestrator delegation:** Orchestrator ¬modify code/docs directly → delegate to domain α. Exception: typo/single-line.
5. **Skill usage:** Always use appropriate skill, even w/o slash command.
6. **Standards reading:** Read relevant standards before code changes.
7. **Test command:** Use `bun run test` (Vitest), ¬`bun test` (Bun runner — CPU spin). Hook blocks wrong cmd.
