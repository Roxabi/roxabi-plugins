# Stack Configuration Reference

`stack.yml` makes dev-core agents project-agnostic. Instead of hardcoding paths and tool names, agents reference values from `.claude/stack.yml`, which is imported into every Claude session via CLAUDE.md `@import`.

## How It Works

Add `@.claude/stack.yml` as the **first line** of your project's `CLAUDE.md`. This loads the entire stack config into context. Agents reference values like `{backend.path}`, `{commands.test}`, `{standards.testing}` — no explicit Read call required.

If `.claude/stack.yml` is absent, agents output:
> "`.claude/stack.yml` not found in context. Add `@.claude/stack.yml` as the first line of your CLAUDE.md, then run `/init` to generate the file, or `/doctor` to diagnose."

## Field Reference

### Top-Level

| Field | Type | Used By | Purpose |
|-------|------|---------|---------|
| `schema_version` | string | doctor | Schema compatibility check |
| `runtime` | string | — | Runtime identifier (informational) |
| `package_manager` | string | security-auditor, devops | Package manager for audit and lock file references |

### `backend.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `backend.framework` | backend-dev | Framework conventions label |
| `backend.orm` | backend-dev | ORM conventions (migration paths, chain mocking) |
| `backend.path` | backend-dev, fixer, tester | Root path of the backend application |

### `frontend.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `frontend.framework` | frontend-dev | Framework conventions label |
| `frontend.path` | frontend-dev, fixer | Root path of the frontend application |
| `frontend.ui_package` | frontend-dev | Import path for the shared UI package |
| `frontend.ui_src` | frontend-dev | Source directory for UI component exports |

### `shared.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `shared.types` | backend-dev, frontend-dev | Shared TypeScript types package path |
| `shared.ui` | frontend-dev, backend-dev (boundary) | Shared UI package path |
| `shared.config` | devops, backend-dev (boundary) | Shared config package path |

### `build.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `build.orchestrator` | devops | Build orchestrator name (for cache references) |
| `build.orchestrator_config` | devops | Config filename for the orchestrator |
| `build.formatter` | devops | Formatter name |
| `build.formatter_config` | devops | Formatter config filename |
| `build.formatter_fix_cmd` | devops | Command to auto-fix formatting |

### `testing.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `testing.unit` | tester | Unit test framework name |
| `testing.e2e` | tester | E2E test framework name |

### `deploy.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `deploy.platform` | devops | Deployment platform name |
| `deploy.secrets_cmd` | devops | Command to add secrets to the platform |

### `docs.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `docs.framework` | doc-writer | Documentation framework (for framework-specific nav rules) |
| `docs.path` | doc-writer | Root documentation directory |
| `docs.format` | doc-writer, product-lead | File extension for documentation files |

### `commands.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `commands.dev` | — | Start development server |
| `commands.build` | devops | Build all packages |
| `commands.test` | tester, fixer | Run the test suite |
| `commands.lint` | fixer, devops | Run linter |
| `commands.typecheck` | fixer, devops | Run type checker |
| `commands.format` | devops | Auto-format files |
| `commands.install` | devops | Install dependencies |

### `artifacts.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `artifacts.analyses` | product-lead, architect | Directory for analysis documents |
| `artifacts.specs` | product-lead | Directory for solution specs |
| `artifacts.frames` | product-lead | Directory for problem frames |
| `artifacts.plans` | product-lead, architect | Directory for implementation plans |

### `standards.*`

| Field | Used By | Purpose |
|-------|---------|---------|
| `standards.backend` | backend-dev, fixer, tester | Backend patterns and conventions |
| `standards.frontend` | frontend-dev, fixer, tester | Frontend patterns and TypeScript gotchas |
| `standards.testing` | tester, fixer, backend-dev, frontend-dev | Test patterns, mocking strategies |
| `standards.code_review` | fixer | Code review conventions |
| `standards.architecture` | architect | Architecture decision records and diagrams |
| `standards.configuration` | devops | Configuration conventions |
| `standards.deployment` | devops | Deployment procedures |
| `standards.troubleshooting` | devops | Troubleshooting guides |
| `standards.issue_management` | product-lead | Issue triage and management process |
| `standards.dev_process` | architect | Development process tiers and phases |
| `standards.contributing` | doc-writer, architect | Contributing guidelines and doc format rules |

## Required Fields

The following fields are required. `/doctor` will flag their absence:

- `schema_version`
- `backend.path`
- `frontend.path`
- `commands.test`
- `commands.lint`
- `commands.typecheck`
- `standards.testing`
- `standards.backend`
- `standards.frontend`

## Writing a Good Standards Doc

Each `standards.*` value points to a doc that agents read before implementing. These docs carry framework-specific knowledge so agent bodies stay generic.

### `standards.testing` template

A good testing standards doc covers:

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

## Example Configs for Common Stacks

### NestJS + TanStack Start (default)

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

## What Happens When a Field Is Missing

| Missing field | Affected agents | Behavior |
|---------------|----------------|---------|
| `backend.path` | backend-dev, fixer | Agent outputs hard-stop error with /init fix instruction |
| `frontend.path` | frontend-dev, fixer | Agent outputs hard-stop error with /init fix instruction |
| `standards.testing` | tester, fixer | Agent cannot read test patterns, falls back to generic guidance |
| `commands.test` | tester, fixer | Agent cannot run tests; reports missing config |
| `standards.backend` | backend-dev | Agent skips framework-specific conventions |
| `standards.frontend` | frontend-dev | Agent skips TypeScript gotchas and UI library patterns |
| `artifacts.*` | product-lead | Agent cannot write artifacts; reports path missing |
