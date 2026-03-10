/**
 * Docs scaffolding — creates standard documentation directory structure.
 * Generates structured template files that align with stack.yml `standards` paths.
 *
 * Templates provide project-specific scaffolding that complements the universal
 * domain knowledge embedded in agent definitions (## Domain Reference).
 *
 * Agent embedded knowledge = universal (Clean Architecture, REST, WCAG — never changes)
 * docs/standards/ templates = project-specific (YOUR ORM, YOUR component library, YOUR CI)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { TemplateFile } from './types'

export interface DocsScaffoldOpts {
  format: 'md' | 'mdx'
  path: string
}

export interface DocsScaffoldResult {
  docsPath: string
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
}

function buildTemplates(format: 'md' | 'mdx'): TemplateFile[] {
  const ext = format === 'mdx' ? 'mdx' : 'md'
  return [
    // -----------------------------------------------------------------------
    // Architecture
    // -----------------------------------------------------------------------
    {
      relativePath: `architecture/index.${ext}`,
      content: `# Architecture

Overview of the project architecture, key design decisions, and system boundaries.

## High-Level Overview

<!-- Describe your system architecture: monolith, microservices, monorepo, or hybrid. -->
<!-- Include a Mermaid diagram if helpful. -->

TODO: Add architecture diagram or description.

## Layers

<!-- Document your project's layer structure. Examples:
  - Domain (entities, value objects, exceptions)
  - Application (use cases, services, ports)
  - Infrastructure (adapters, repositories, controllers, config)
-->

TODO: Map your layers and their boundaries.

## Key Decisions

See the \`adr/\` directory for Architecture Decision Records.
`,
    },
    {
      relativePath: `architecture/patterns.${ext}`,
      content: `# Patterns

Recurring patterns and conventions used in this project.

## Naming Conventions

<!-- Document your project's naming rules. Examples:
  - Files: kebab-case (user-service.ts)
  - Classes: PascalCase (UserService)
  - Functions: camelCase (getUserById)
  - Constants: UPPER_SNAKE (MAX_RETRY_COUNT)
  - Database tables: snake_case (user_accounts)
-->

TODO: Document naming conventions.

## Error Handling

<!-- Document your error hierarchy. Example:
  - AppError (base) → NotFoundError, ValidationError, AuthError
  - Where errors are caught (controller boundary? middleware?)
  - How errors map to responses (domain exception → HTTP status code)
-->

TODO: Document error handling patterns.

## Data Flow

<!-- Document how data moves through your system. Example:
  - Request → Controller → Service → Repository → Database
  - Events/messages between modules
  - Shared types and DTOs
-->

TODO: Document data flow patterns.
`,
    },
    {
      relativePath: `architecture/ubiquitous-language.${ext}`,
      content: `# Ubiquitous Language

Glossary of domain terms used in this project. Keeps agents and contributors aligned on vocabulary.

## Glossary

| Term | Definition | Source |
|------|-----------|--------|

<!-- Add domain-specific terms as they emerge. Examples:
  | Workspace | A collection of projects owned by one org | workspace.ts |
  | Pipeline  | The sequence of build/test/deploy steps    | ci.yml       |
-->

TODO: Add domain-specific terms as they emerge from codebase analysis.

## Common Confusions

<!-- Document terms that are easily mixed up in your domain. Examples:
  - "user" vs "account" vs "profile"
  - "project" vs "workspace" vs "organization"
-->

TODO: Document terms that are easily mixed up.
`,
    },
    // -----------------------------------------------------------------------
    // Standards — used by agents via {standards.xxx}
    // -----------------------------------------------------------------------
    {
      relativePath: `standards/backend-patterns.${ext}`,
      content: `# Backend Patterns

Project-specific backend conventions. Agents read this via \`{standards.backend}\`.

> Universal patterns (REST status codes, ORM anti-patterns, error handling) are embedded in the \`backend-dev\` agent.
> This file documents **your project's specific** choices.

## Framework & ORM

<!-- Document your specific stack. Examples:
  - Framework: NestJS with modular architecture
  - ORM: Prisma with PostgreSQL
  - Validation: Zod schemas at controller boundary
-->

TODO: Document your framework and ORM choices.

## Module Structure

<!-- Document your file organization. Example:
  src/
    modules/
      user/
        user.controller.ts    # HTTP layer
        user.service.ts        # Business logic
        user.repository.ts     # Data access
        user.dto.ts            # Input/output shapes
        user.test.ts           # Co-located tests
        exceptions/
          user-not-found.ts    # Domain exceptions
-->

TODO: Document your module/file organization.

## API Conventions

<!-- Document project-specific API rules. Examples:
  - All endpoints prefixed with /api/v1/
  - Pagination: cursor-based (not offset)
  - Auth: Bearer JWT in Authorization header
  - Error response shape: { error: { code, message, details } }
-->

TODO: Document your API conventions.

## Data Access Rules

<!-- Document ORM-specific rules. Examples:
  - Always use Prisma transactions for multi-write operations
  - Eager loading: use \`include\` for 1-level, \`select\` for deep queries
  - Never use raw SQL except in migrations
-->

TODO: Document your data access rules.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. Examples:
  - ALWAYS use Prisma \`include\` for related data (never N+1)
  - NEVER import from \`@/modules/user\` in \`@/modules/auth\` (use events)
  - ALWAYS validate with Zod at controller boundary
-->

TODO: Add concise, imperative rules for agents.
`,
    },
    {
      relativePath: `standards/frontend-patterns.${ext}`,
      content: `# Frontend Patterns

Project-specific frontend conventions. Agents read this via \`{standards.frontend}\`.

> Universal patterns (component design, state management signals, WCAG 2.1 AA, performance) are embedded in the \`frontend-dev\` agent.
> This file documents **your project's specific** choices.

## Framework & UI Library

<!-- Document your specific stack. Examples:
  - Framework: Next.js 15 (App Router)
  - UI Library: shadcn/ui + Radix primitives
  - Styling: Tailwind CSS v4
  - State: TanStack Query for server state, Zustand for client state
-->

TODO: Document your framework and UI library choices.

## Component Conventions

<!-- Document project-specific component rules. Examples:
  - All shared components in packages/ui/src/
  - Page components in apps/web/src/app/
  - Always use shadcn/ui primitives before hand-rolling
  - Customize via className prop (never override internal styles)
-->

TODO: Document your component conventions.

## Routing & Data Fetching

<!-- Document how your app handles routing and data. Examples:
  - File-based routing (Next.js App Router)
  - Server Components by default, Client Components only when interactive
  - Data fetching: RSC for initial load, TanStack Query for mutations/polling
-->

TODO: Document routing and data fetching patterns.

## Forms & Validation

<!-- Document your form patterns. Examples:
  - React Hook Form + Zod for all forms
  - Server-side validation mirrors client-side schemas
  - Error display: inline per field + toast for server errors
-->

TODO: Document form handling patterns.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. Examples:
  - ALWAYS check packages/ui/src/index.ts for existing primitives before creating
  - NEVER use \`useEffect\` for derived state — use \`useMemo\` or compute in render
  - ALWAYS use Server Components by default (add "use client" only when needed)
-->

TODO: Add concise, imperative rules for agents.
`,
    },
    {
      relativePath: `standards/testing.${ext}`,
      content: `# Testing Standards

Project-specific testing conventions. Agents read this via \`{standards.testing}\`.

> Universal patterns (Testing Trophy, mock boundaries, coverage anti-patterns, flaky test classification) are embedded in the \`tester\` agent.
> This file documents **your project's specific** testing setup.

## Framework Setup

<!-- Document your test framework configuration. Examples:
  - Unit/Integration: Vitest with \`vitest.config.ts\`
  - E2E: Playwright with \`playwright.config.ts\`
  - Global setup: \`vitest.setup.ts\` (MSW server, test DB)
-->

TODO: Document your test framework setup.

## Mocking Strategy

<!-- Document what you mock and how. Examples:
  - HTTP: MSW (Mock Service Worker) for all API calls
  - Database: Prisma test client with per-test transactions
  - Time: vi.useFakeTimers() for time-dependent tests
  - Environment: .env.test with test-specific values
-->

TODO: Document your mocking strategy.

## Coverage Thresholds

<!-- Document your coverage requirements. Examples:
  - Overall: 80% line coverage minimum
  - Critical paths (auth, payments): 95%
  - New code: must not decrease overall coverage
-->

TODO: Document coverage thresholds.

## ESM Conventions

<!-- Document ESM-specific gotchas for your setup. Examples:
  - Vitest handles ESM natively (no CJS transform needed)
  - Use vi.mock() with factory for ESM module mocking
  - Import assertions for JSON: import data from './data.json' assert { type: 'json' }
-->

TODO: Document ESM conventions for testing.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. Examples:
  - ALWAYS use MSW for HTTP mocking (never vi.mock fetch)
  - NEVER mock the module under test
  - ALWAYS run \`bun run test --coverage <file>\` after writing tests — 0% means wrong mocking
-->

TODO: Add concise, imperative rules for agents.
`,
    },
    {
      relativePath: `standards/code-review.${ext}`,
      content: `# Code Review Standards

Project-specific review guidelines. Agents read this via \`{standards.code_review}\`.

> Universal patterns (security checklist, severity definitions) are embedded in the \`security-auditor\` agent.
> This file documents **your project's specific** review criteria.

## Review Checklist

- [ ] Code follows project patterns (see \`backend-patterns\` / \`frontend-patterns\`)
- [ ] Tests added/updated for all changed behavior
- [ ] No security vulnerabilities introduced (see security-auditor agent)
- [ ] Documentation updated if public API changed
- [ ] No TODO comments without linked issue
- [ ] Types are explicit (no \`any\` without justification)

## Conventional Comments

Reviews use Conventional Comments format:

| Label | Blocks merge? | When |
|-------|:---:|------|
| \`issue(blocking):\` | Yes | Bug, security, spec violation |
| \`suggestion(blocking):\` | Yes | Standard violation |
| \`suggestion(non-blocking):\` | No | Improvement idea |
| \`nitpick:\` | No | Style preference |
| \`praise:\` | No | Good work worth noting |

## Project-Specific Rules

<!-- Add review rules specific to your project. Examples:
  - All Prisma schema changes need migration review
  - New API endpoints need OpenAPI spec update
  - New shared components need Storybook story
-->

TODO: Add project-specific review rules.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. -->

TODO: Add concise, imperative rules for agents.
`,
    },
    // -----------------------------------------------------------------------
    // Guides — used by devops agent
    // -----------------------------------------------------------------------
    {
      relativePath: `guides/deployment.${ext}`,
      content: `# Deployment Guide

Project-specific deployment procedures. Agents read this via \`{standards.deployment}\`.

> Universal patterns (CI/CD pipeline stages, Docker best practices, secret management) are embedded in the \`devops\` agent.
> This file documents **your project's specific** deployment setup.

## Environments

<!-- Document your deployment environments. Examples:
  | Environment | URL | Branch | Auto-deploy? |
  |-------------|-----|--------|:---:|
  | Production  | app.example.com | main | No (manual promote) |
  | Staging     | staging.example.com | staging | Yes |
  | Preview     | pr-N.example.com | PR branches | Yes |
-->

TODO: Document your environments.

## Deploy Process

<!-- Document how deployments work. Examples:
  - Vercel auto-deploys on push to staging
  - Production: /promote creates staging→main PR, merge triggers deploy
  - Rollback: revert commit on main, auto-redeploy
-->

TODO: Document your deploy process.

## Environment Variables

<!-- Document required env vars per environment. Examples:
  | Variable | Required | Where | Description |
  |----------|:---:|-------|-------------|
  | DATABASE_URL | Yes | Vercel env | PostgreSQL connection string |
  | NEXTAUTH_SECRET | Yes | Vercel env | Auth session encryption |
-->

TODO: Document environment variables.

## Monitoring & Health Checks

<!-- Document how you monitor deployments. Examples:
  - Health endpoint: GET /api/health (returns 200 + version)
  - Error tracking: Sentry (auto-captured)
  - Uptime: Vercel Analytics
-->

TODO: Document monitoring setup.
`,
    },
    {
      relativePath: `guides/troubleshooting.${ext}`,
      content: `# Troubleshooting Guide

Common issues and their solutions. Agents read this via \`{standards.troubleshooting}\`.

## Build Failures

<!-- Document common build issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | \`Module not found: @repo/ui\` | Missing turbo dependency | \`bun install\` in monorepo root |
  | TypeScript errors in CI but not local | Different TS version | Check \`tsconfig.json\` extends |
-->

TODO: Document common build failures.

## Test Failures

<!-- Document common test issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | Tests pass locally, fail in CI | Missing env vars | Check \`.env.test\` vs CI secrets |
  | Flaky timeout errors | MSW not intercepting | Check handler setup in \`vitest.setup.ts\` |
-->

TODO: Document common test failures.

## Development Environment

<!-- Document local dev issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | Port 3000 already in use | Stale process | \`lsof -ti:3000 | xargs kill\` |
  | Prisma client out of date | Schema changed | \`bunx prisma generate\` |
-->

TODO: Document common dev environment issues.
`,
    },
    // -----------------------------------------------------------------------
    // Processes — used by product-lead and architect agents
    // -----------------------------------------------------------------------
    {
      relativePath: `processes/issue-management.${ext}`,
      content: `# Issue Management

Project-specific issue conventions. Agents read this via \`{standards.issue_management}\`.

> Universal patterns (severity x impact matrix, spec completeness checklist) are embedded in the \`product-lead\` agent.
> This file documents **your project's specific** issue workflow.

## Issue Lifecycle

<!-- Document your issue states. Example:
  Triage → Analysis → Specs → Planning → In Progress → In Review → Done
-->

TODO: Document your issue lifecycle.

## Labels

<!-- Document your label taxonomy. Examples:
  | Category | Labels | Purpose |
  |----------|--------|---------|
  | Type | bug, feature, enhancement, docs | What kind of work |
  | Size | XS, S, M, L, XL | Effort estimate |
  | Priority | P0, P1, P2, P3 | Urgency |
  | Area | frontend, backend, infra, docs | Which domain |
-->

TODO: Document your labels.

## Templates

<!-- Document issue templates your project uses. Examples:
  - Bug report: reproduction steps, expected vs actual, environment
  - Feature request: problem, proposed solution, alternatives
  - Technical debt: current state, desired state, effort
-->

TODO: Document issue templates.

## Sizing Guidelines

<!-- Document what each size means for your project. Examples:
  | Size | Time | Scope |
  |------|------|-------|
  | XS   | <1h  | Typo fix, config tweak |
  | S    | <4h  | Single-file change, simple bug fix |
  | M    | 1-2d | Multi-file feature, clear scope |
  | L    | 3-5d | Cross-domain feature, needs spec |
  | XL   | >1w  | New system, architecture change |
-->

TODO: Document sizing guidelines.
`,
    },
    {
      relativePath: `processes/dev-process.${ext}`,
      content: `# Development Process

Project-specific development workflow. Agents read this via \`{standards.dev_process}\`.

## Branch Strategy

<!-- Document your branching model. Example:
  - main: production (protected, squash merge only)
  - staging: integration (auto-deploy to staging env)
  - feat/N-slug: feature branches (from staging)
  - fix/N-slug: bug fixes (from staging)
-->

TODO: Document your branch strategy.

## Workflow

<!-- Document the development flow for your team. Example:
  1. /dev #N → determines tier (S / F-lite / F-full)
  2. Frame → Spec → Plan (artifacts reviewed at each gate)
  3. Implement in worktree (git worktree add ../project-N)
  4. PR → review → fix → merge to staging
  5. /promote → staging→main PR → production deploy
-->

TODO: Document your development workflow.

## Code Ownership

<!-- Document who owns what. Examples:
  | Path | Owner | Review required? |
  |------|-------|:---:|
  | apps/web/ | Frontend team | Yes |
  | apps/api/ | Backend team | Yes |
  | packages/ui/ | Design system team | Yes |
  | .github/ | DevOps | Yes |
-->

TODO: Document code ownership.

## Release Process

<!-- Document how releases work. Examples:
  - /promote creates staging→main PR with changelog
  - Version bumps follow semver (breaking=major, feature=minor, fix=patch)
  - Tags created automatically on merge to main
-->

TODO: Document your release process.
`,
    },
    // -----------------------------------------------------------------------
    // Configuration & Contributing
    // -----------------------------------------------------------------------
    {
      relativePath: `configuration.${ext}`,
      content: `# Configuration

How the project is configured. Agents read this via \`{standards.configuration}\`.

## Environment Variables

<!-- Document required and optional env vars. Example:
  | Variable | Required | Default | Description |
  |----------|:---:|---------|-------------|
  | DATABASE_URL | Yes | — | PostgreSQL connection string |
  | PORT | No | 3000 | Server port |
  | LOG_LEVEL | No | info | Logging verbosity |
-->

TODO: Document environment variables.

## Config Files

<!-- Document configuration files and their purpose. Example:
  | File | Purpose | Committed? |
  |------|---------|:---:|
  | .claude/stack.yml | Dev-core stack config | No (.gitignored) |
  | .claude/dev-core.yml | Dev-core plugin config | No (.gitignored) |
  | biome.json | Linter/formatter config | Yes |
  | tsconfig.json | TypeScript config | Yes |
-->

TODO: Document config files.

## Priority Chain

<!-- Document precedence when multiple config sources exist. Example:
  1. Environment variable (highest)
  2. .claude/dev-core.yml
  3. .env file
  4. Default value (lowest)
-->

TODO: Document config priority chain.
`,
    },
    {
      relativePath: `contributing.${ext}`,
      content: `# Contributing

How to contribute to this project.

## Getting Started

<!-- Document setup steps. Example:
  1. Clone the repo
  2. \`bun install\`
  3. \`cp .env.example .env\` and fill in values
  4. \`bun dev\` to start development server
-->

TODO: Document setup steps.

## Development Workflow

<!-- Document the contribution workflow. Example:
  1. Create/pick an issue
  2. \`/dev #N\` to start the workflow
  3. Code in a worktree
  4. PR against staging (not main)
  5. Review → fix → merge
-->

TODO: Document development workflow.

## Commit Conventions

Commits follow Conventional Commits: \`<type>(<scope>): <description>\`

Types: \`feat\` | \`fix\` | \`refactor\` | \`docs\` | \`style\` | \`test\` | \`chore\` | \`ci\` | \`perf\`

## Documentation

<!-- Document doc conventions. Examples:
  - Docs live in docs/ (MDX format)
  - Update docs when changing public APIs
  - Run /doc-sync after code changes to catch stale references
-->

TODO: Document documentation conventions.
`,
    },
  ]
}

export function scaffoldDocs(opts: DocsScaffoldOpts): DocsScaffoldResult {
  const { format, path: docsPath } = opts
  const result: DocsScaffoldResult = {
    docsPath,
    dirsCreated: [],
    filesCreated: [],
    filesSkipped: [],
  }

  const dirs = ['architecture', 'architecture/adr', 'standards', 'guides', 'processes']

  for (const dir of dirs) {
    const fullDir = `${docsPath}/${dir}`
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true })
      result.dirsCreated.push(dir)
    }
  }

  const templates = buildTemplates(format)

  for (const tpl of templates) {
    const fullPath = `${docsPath}/${tpl.relativePath}`
    if (existsSync(fullPath)) {
      result.filesSkipped.push(tpl.relativePath)
    } else {
      writeFileSync(fullPath, tpl.content)
      result.filesCreated.push(tpl.relativePath)
    }
  }

  return result
}
