# Stack Configuration Reference

Let: α := agent(s) | σ := stack.yml field

`stack.yml` makes dev-core agents project-agnostic. Agents reference `{backend.path}`, `{commands.test}`, etc. from `.claude/stack.yml`, imported via CLAUDE.md `@import`.

Add `@.claude/stack.yml` as **first line** of CLAUDE.md. ¬∃ `.claude/stack.yml` → agents output:
> "`.claude/stack.yml` not found in context. Add `@.claude/stack.yml` as the first line of your CLAUDE.md, then run `/init` to generate the file, or `/R-dev-checkup` to diagnose."

## Field Reference

### Top-Level

| σ | Type | α | Purpose |
|---|------|---|---------|
| `schema_version` | string | checkup | Schema compat check |
| `runtime` | string | — | Runtime ID (informational) |
| `package_manager` | string | R-security-auditor, R-devops | Pkg mgr for audit/lockfile |

### `backend.*`

| σ | α | Purpose |
|---|---|---------|
| `backend.framework` | R-backend-dev | Framework conventions |
| `backend.orm` | R-backend-dev | ORM conventions (migrations, chain mocking) |
| `backend.path` | R-backend-dev, R-fixer, R-tester | Backend app root |

### `frontend.*`

| σ | α | Purpose |
|---|---|---------|
| `frontend.framework` | R-frontend-dev | Framework conventions |
| `frontend.path` | R-frontend-dev, R-fixer | Frontend app root |
| `frontend.ui_package` | R-frontend-dev | Shared UI import path |
| `frontend.ui_src` | R-frontend-dev | UI component exports dir |

### `shared.*`

| σ | α | Purpose |
|---|---|---------|
| `shared.types` | R-backend-dev, R-frontend-dev | Shared TS types path |
| `shared.ui` | R-frontend-dev, R-backend-dev (boundary) | Shared UI path |
| `shared.config` | R-devops, R-backend-dev (boundary) | Shared config path |

### `build.*`

| σ | α | Purpose |
|---|---|---------|
| `build.orchestrator` | R-devops | Build orchestrator name |
| `build.orchestrator_config` | R-devops | Orchestrator config file |
| `build.formatter` | R-devops | Formatter name |
| `build.formatter_config` | R-devops | Formatter config file |
| `build.formatter_fix_cmd` | R-devops | Auto-fix formatting cmd |

### `testing.*`

| σ | α | Purpose |
|---|---|---------|
| `testing.unit` | R-tester | Unit test framework |
| `testing.e2e` | R-tester | E2E test framework |

### `hooks.*`

| σ | α | Purpose |
|---|---|---------|
| `hooks.tool` | ci-setup, release-setup | Hook runner selection: `auto` \| `lefthook` \| `pre-commit` \| `husky` \| `none`. `auto` → infers from runtime (Python → pre-commit, else lefthook). Consumed by `/R-ci-setup` (installs pre-commit hooks) and `/R-release-setup` (wires commit-msg hook). |

### `deploy.*`

| σ | α | Purpose |
|---|---|---------|
| `deploy.platform` | R-devops | Deploy platform name |
| `deploy.secrets_cmd` | R-devops | Add-secrets cmd |

### `docs.*`

| σ | α | Purpose |
|---|---|---------|
| `docs.framework` | R-doc-writer | Optional site framework (`none` default; Fumadocs removed) |
| `docs.path` | R-doc-writer | Root doc dir |
| `docs.format` | R-doc-writer (informational) | Fixed `md` write path; field optional/compat only. Legacy `.mdx` read-only |

### `commands.*`

| σ | α | Purpose |
|---|---|---------|
| `commands.dev` | — | Start dev server |
| `commands.build` | R-devops | Build all packages |
| `commands.test` | R-tester, R-fixer | Run test suite |
| `commands.test:falsify` | implement, test, validate | Optional mechanical falsify gate. YAML key must be quoted (`"test:falsify"`). Absent → `/R-validate --full` ⏭; `/R-dev-implement` 6b falls back to git-stash |
| `commands.lint` | R-fixer, R-devops | Run linter |
| `commands.typecheck` | R-fixer, R-devops | Run type checker |
| `commands.format` | R-devops | Auto-format |
| `commands.install` | R-devops | Install deps |

### `artifacts.*`

| σ | α | Purpose |
|---|---|---------|
| `artifacts.analyses` | R-product-lead, R-architect | Analysis docs dir |
| `artifacts.specs` | R-product-lead | Specs dir |
| `artifacts.frames` | R-product-lead | Frames dir |
| `artifacts.plans` | R-product-lead, R-architect | Plans dir |

### `review.*`

Consumer: `plugins/dev-core/skills/dev-review/roster.sh` (the deterministic roster oracle — the skill spawns exactly its `agents[]`).

| σ | α | Purpose |
|---|---|---------|
| `review.roster.max_agents` | dev-review | Cap on the spawn set per chunk lane (excl. R-recall / R-finding-verifier). Default `4`; `<1` clamps to `1` + warning |
| `review.roster.max_agents_review` | dev-review | Aggregate cap on flattened Lane A instances after COLLAPSE_ONCE. Default `0` = off (collapse is the bound). `<0` clamps to `0` + warning |
| `review.roster.verify_below_confidence` | dev-review | Keep/drop pass over findings below this C. Default `90`; `0` disables the keep/drop filter |
| `review.roster.recall_min_delta` | dev-review | Recall needs multi-chunk ∧ `|Δ|` > this. Default `50` |
| `review.roster.agents.<agent>` | dev-review | Per-agent override: `default` \| `always` \| `never`. Default `default`. `R-adversarial` is a floor (`never` ignored). `R-product-lead` is not a roster agent (Phase 2 covers spec compliance) |

### `standards.*`

| σ | α | Purpose |
|---|---|---------|
| `standards.backend` | R-backend-dev, R-fixer, R-tester | Backend patterns |
| `standards.frontend` | R-frontend-dev, R-fixer, R-tester | Frontend patterns + TS gotchas |
| `standards.testing` | R-tester, R-fixer, R-backend-dev, R-frontend-dev | Test patterns, mocking |
| `standards.code_review` | R-fixer | Code review conventions |
| `standards.architecture` | R-architect | ADRs + diagrams |
| `standards.configuration` | R-devops | Config conventions |
| `standards.deployment` | R-devops | Deploy procedures |
| `standards.troubleshooting` | R-devops | Troubleshooting guides |
| `standards.issue_management` | R-product-lead | Issue triage/mgmt |
| `standards.dev_process` | R-architect | Dev process tiers/phases |
| `standards.contributing` | R-doc-writer, R-architect | Contributing + doc format |

## Required Fields

`/R-dev-checkup` flags absence of: `schema_version`, `backend.path`, `frontend.path`, `commands.test`, `commands.lint`, `commands.typecheck`, `standards.testing`, `standards.backend`, `standards.frontend`

## Writing Good Standards Docs

Each `standards.*` → doc agents read before implementing. Framework-specific knowledge keeps agent bodies generic.

### `standards.testing` template

```markdown
## Framework Setup
- Test runner config (vitest.config.ts / jest.config.ts / etc.)
- Setup files and global teardown
- Environment selection (node vs jsdom)

## Import Conventions
- ESM extension requirements (e.g., `.js` extensions for Node ESM)
- Explicit imports from test framework (no globals)

## Controller / Handler Tests
- How to instantiate controllers directly
- Mock reset pattern (beforeEach)
- Decorator metadata verification

## Service / Repository Tests
- DB/ORM chain mocking pattern
- Factory helper shape (createMockDb, etc.)
- Multi-call sequences

## Exception Patterns
- Exception class shape
- Where exceptions live in the project

## Frontend Component Tests
- Provider wrapper pattern
- Query cache seeding vs real fetch
```

### `standards.backend` template

```markdown
## Module Structure
- One module per domain feature
- Controller → HTTP only, logic → services
- Domain exceptions: no framework imports

## ORM Conventions
- Migration directory and naming
- Chain patterns for queries

## API Conventions
- Request validation
- Response shapes
- Error codes
```

## Example Configs

### NestJS + TanStack Start

```yaml
schema_version: "1.0"
runtime: bun
package_manager: bun
backend:
  framework: nestjs
  orm: drizzle
  path: apps/api
frontend:
  framework: tanstack-start
  path: apps/web
  ui_package: "@repo/ui"
  ui_src: packages/ui/src
```

### Next.js + Express

```yaml
schema_version: "1.0"
runtime: node
package_manager: npm
backend:
  framework: express
  orm: prisma
  path: server
frontend:
  framework: nextjs
  path: app
  ui_package: "@/components/ui"
  ui_src: components/ui
```

### SvelteKit + Rails

```yaml
schema_version: "1.0"
runtime: node
package_manager: pnpm
backend:
  framework: rails
  orm: none
  path: backend
frontend:
  framework: sveltekit
  path: frontend
  ui_package: "$lib/components"
  ui_src: src/lib/components
```

## Missing Field Behavior

| Missing σ | Affected α | Behavior |
|-----------|-----------|---------|
| `backend.path` | R-backend-dev, R-fixer | Hard-stop error w/ /init fix |
| `frontend.path` | R-frontend-dev, R-fixer | Hard-stop error w/ /init fix |
| `standards.testing` | R-tester, R-fixer | Falls back to generic guidance |
| `commands.test` | R-tester, R-fixer | Cannot run tests; reports missing config |
| `standards.backend` | R-backend-dev | Skips framework-specific conventions |
| `standards.frontend` | R-frontend-dev | Skips TS gotchas + UI library patterns |
| `artifacts.*` | R-product-lead | Cannot write artifacts; reports path missing |
| `review.roster.*` | dev-review | Defaults: max_agents 4, max_agents_review 0, verify_below_confidence 90, recall_min_delta 50, every agent default |
