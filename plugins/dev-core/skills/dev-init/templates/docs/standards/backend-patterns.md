# Backend Patterns

Project-specific backend conventions. Agents read this via `{standards.backend}`.

> Universal patterns (REST status codes, ORM anti-patterns, error handling) are embedded in the `backend-dev` agent.
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
  - Eager loading: use `include` for 1-level, `select` for deep queries
  - Never use raw SQL except in migrations
-->

TODO: Document your data access rules.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. Examples:
  - ALWAYS use Prisma `include` for related data (never N+1)
  - NEVER import from `@/modules/user` in `@/modules/auth` (use events)
  - ALWAYS validate with Zod at controller boundary
-->

TODO: Add concise, imperative rules for agents.
