# Testing Standards

Project-specific testing conventions. Agents read this via `{standards.testing}`.

> Universal patterns (Testing Trophy, mock boundaries, coverage anti-patterns, flaky test classification) are embedded in the `tester` agent.
> This file documents **your project's specific** testing setup.

## Framework Setup

<!-- Document your test framework configuration. Examples:
  - Unit/Integration: Vitest with `vitest.config.ts`
  - E2E: Playwright with `playwright.config.ts`
  - Global setup: `vitest.setup.ts` (MSW server, test DB)
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
  - ALWAYS run `bun run test --coverage <file>` after writing tests — 0% means wrong mocking
-->

TODO: Add concise, imperative rules for agents.
