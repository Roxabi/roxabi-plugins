# Stack Configuration Reference

Let: α := agent(s) | σ := stack.yml field

`stack.yml` makes dev-core agents project-agnostic. Agents reference `{backend.path}`, `{commands.test}`, etc. from `.claude/stack.yml`, imported via CLAUDE.md `@import`.

Add `@.claude/stack.yml` as **first line** of CLAUDE.md. ¬∃ `.claude/stack.yml` → agents output:
> "`.claude/stack.yml` not found in context. Add `@.claude/stack.yml` as the first line of your CLAUDE.md, then run `/init` to generate the file, or `/doctor` to diagnose."

## Field Reference

### Top-Level

| σ | Type | α | Purpose |
|---|------|---|---------|
| `schema_version` | string | doctor | Schema compat check |
| `runtime` | string | — | Runtime ID (informational) |
| `package_manager` | string | security-auditor, devops | Pkg mgr for audit/lockfile |

### `backend.*`

| σ | α | Purpose |
|---|---|---------|
| `backend.framework` | backend-dev | Framework conventions |
| `backend.orm` | backend-dev | ORM conventions (migrations, chain mocking) |
| `backend.path` | backend-dev, fixer, tester | Backend app root |

### `frontend.*`

| σ | α | Purpose |
|---|---|---------|
| `frontend.framework` | frontend-dev | Framework conventions |
| `frontend.path` | frontend-dev, fixer | Frontend app root |
| `frontend.ui_package` | frontend-dev | Shared UI import path |
| `frontend.ui_src` | frontend-dev | UI component exports dir |

### `shared.*`

| σ | α | Purpose |
|---|---|---------|
| `shared.types` | backend-dev, frontend-dev | Shared TS types path |
| `shared.ui` | frontend-dev, backend-dev (boundary) | Shared UI path |
| `shared.config` | devops, backend-dev (boundary) | Shared config path |

### `build.*`

| σ | α | Purpose |
|---|---|---------|
| `build.orchestrator` | devops | Build orchestrator name |
| `build.orchestrator_config` | devops | Orchestrator config file |
| `build.formatter` | devops | Formatter name |
| `build.formatter_config` | devops | Formatter config file |
| `build.formatter_fix_cmd` | devops | Auto-fix formatting cmd |

### `testing.*`

| σ | α | Purpose |
|---|---|---------|
| `testing.unit` | tester | Unit test framework |
| `testing.e2e` | tester | E2E test framework |

### `deploy.*`

| σ | α | Purpose |
|---|---|---------|
| `deploy.platform` | devops | Deploy platform name |
| `deploy.secrets_cmd` | devops | Add-secrets cmd |

### `docs.*`

| σ | α | Purpose |
|---|---|---------|
| `docs.framework` | doc-writer | Doc framework (nav rules) |
| `docs.path` | doc-writer | Root doc dir |
| `docs.format` | doc-writer, product-lead | Doc file extension |

### `commands.*`

| σ | α | Purpose |
|---|---|---------|
| `commands.dev` | — | Start dev server |
| `commands.build` | devops | Build all packages |
| `commands.test` | tester, fixer | Run test suite |
| `commands.lint` | fixer, devops | Run linter |
| `commands.typecheck` | fixer, devops | Run type checker |
| `commands.format` | devops | Auto-format |
| `commands.install` | devops | Install deps |

### `artifacts.*`

| σ | α | Purpose |
|---|---|---------|
| `artifacts.analyses` | product-lead, architect | Analysis docs dir |
| `artifacts.specs` | product-lead | Specs dir |
| `artifacts.frames` | product-lead | Frames dir |
| `artifacts.plans` | product-lead, architect | Plans dir |

### `standards.*`

| σ | α | Purpose |
|---|---|---------|
| `standards.backend` | backend-dev, fixer, tester | Backend patterns |
| `standards.frontend` | frontend-dev, fixer, tester | Frontend patterns + TS gotchas |
| `standards.testing` | tester, fixer, backend-dev, frontend-dev | Test patterns, mocking |
| `standards.code_review` | fixer | Code review conventions |
| `standards.architecture` | architect | ADRs + diagrams |
| `standards.configuration` | devops | Config conventions |
| `standards.deployment` | devops | Deploy procedures |
| `standards.troubleshooting` | devops | Troubleshooting guides |
| `standards.issue_management` | product-lead | Issue triage/mgmt |
| `standards.dev_process` | architect | Dev process tiers/phases |
| `standards.contributing` | doc-writer, architect | Contributing + doc format |

## Required Fields

`/doctor` flags absence of: `schema_version`, `backend.path`, `frontend.path`, `commands.test`, `commands.lint`, `commands.typecheck`, `standards.testing`, `standards.backend`, `standards.frontend`

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
| `backend.path` | backend-dev, fixer | Hard-stop error w/ /init fix |
| `frontend.path` | frontend-dev, fixer | Hard-stop error w/ /init fix |
| `standards.testing` | tester, fixer | Falls back to generic guidance |
| `commands.test` | tester, fixer | Cannot run tests; reports missing config |
| `standards.backend` | backend-dev | Skips framework-specific conventions |
| `standards.frontend` | frontend-dev | Skips TS gotchas + UI library patterns |
| `artifacts.*` | product-lead | Cannot write artifacts; reports path missing |
