# Dev Process Reference

> Extracted from the Roxabi boilerplate `CLAUDE.md`. This is a reference copy for the dev-core plugin. The canonical source lives in the boilerplate repository.

## Tier System

The `/dev #N` entry point determines issue tier based on complexity:

| Tier | Criteria | Phases |
|------|----------|--------|
| **S** | <=3 files, no arch, no risk | triage -> implement -> pr -> validate -> review -> fix* -> promote* -> cleanup* |
| **F-lite** | Clear scope, single domain | Frame -> spec -> plan -> implement -> verify -> ship |
| **F-full** | New arch, unclear reqs, >2 domains | Frame -> analyze -> spec -> plan -> implement -> verify -> ship |

`*` = conditional (runs only if applicable -- e.g., fix runs only if review produces findings)

## Workflow Phases

Phases flow in order: **Frame** (problem) -> **Shape** (spec) -> **Build** (code) -> **Verify** (review) -> **Ship** (release).

- **Frame:** Define the problem space. Creates the initial feature frame from the GitHub issue.
- **Shape:** Deep analysis (F-full only), specification, requirements gathering. Produces specs with smart splitting.
- **Build:** Implementation plan with micro-tasks, code execution, pull request creation.
- **Verify:** Code review against quality gates, fix application, validation against spec.
- **Ship:** Post-merge cleanup, promotion to staging/production.

## Artifact Model

Artifacts are the state markers `/dev` uses for progress detection and resumption.

| Type | Directory | Question Answered |
|------|-----------|-------------------|
| **Frame** | `artifacts/frames/` | What's the problem? |
| **Analysis** | `artifacts/analyses/` | How deep is it? |
| **Spec** | `artifacts/specs/` | What will we build? |
| **Plan** | `artifacts/plans/` | How do we build it? |

The `/dev` orchestrator scans these directories to determine current progress and resume from the correct phase.

## Git Workflow Rules

### Worktree

All code changes require a worktree:

```bash
git worktree add ../roxabi-XXX -b feat/XXX-slug staging
cd ../roxabi-XXX && cp .env.example .env && bun install
cd apps/api && bun run db:branch:create --force XXX
```

**Exceptions:**
- XS issues (confirm via AskUserQuestion)
- `/dev` pre-implementation artifacts (frame, analysis, spec, plan)
- `/promote` release artifacts

Never code on main/staging without a worktree.

### Commit Format

```
<type>(<scope>): <desc>
```

Followed by: `Co-Authored-By: Claude <model> <noreply@anthropic.com>`

Types: `feat` | `fix` | `refactor` | `docs` | `style` | `test` | `chore` | `ci` | `perf`

### Branch Naming

`feat/XXX-slug` where XXX is the issue number.

## Quality Gate Requirements

- Code review uses Conventional Comments format
- Block only on: security, correctness, standard violations
- Must read code-review standards before reviewing
- CI must pass before merge
- Human approves at every gate

## Mandatory Rules

1. **AskUserQuestion:** Always use `AskUserQuestion` for decisions, choices (>=2 options), and approach proposals. Never use plain-text questions like "Do you want..." or "Should I..."
2. **No force/amend:** Never use `--force`, `--hard`, or `--amend`. Hook fail -> fix + NEW commit.
3. **No push without request:** Never push without explicit user request.
4. **Orchestrator delegation:** Orchestrator does not modify code/docs directly. Delegate to domain agents. Exception: typo/single-line fixes.
5. **Skill usage:** Always use the appropriate skill, even without a slash command.
6. **Standards reading:** Before code changes, read the relevant standards document for the context.
7. **Test command:** Use `bun run test` (Vitest), never `bun test` (Bun runner -- causes CPU spin). A hook blocks the wrong command.
