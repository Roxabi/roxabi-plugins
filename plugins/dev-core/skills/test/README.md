# test

Generate or run unit, integration, and Playwright e2e tests following existing codebase patterns.

## Why

Writing tests is slow when you have to figure out describe/it structure, mock strategies, and assertion style from scratch. `/test` reads the existing test patterns in your project and generates tests that match them exactly — with AAA structure, correct mocking for Bun/Vitest, and coverage for happy paths, edge cases, and error cases.

## Usage

```
/test                      Generate tests for files changed vs base branch
/test src/auth/login.ts    Generate tests for a specific file
/test --e2e                Generate Playwright e2e tests for changed files
/test --run                Run existing tests (commands.test from stack.yml)
```

Triggers: `"test this file"` | `"write tests"` | `"add coverage"` | `"run tests"` | `"e2e tests"` | `"generate tests"` | `"write unit tests"`

## How it works

1. **Identify targets** — diffs vs base branch (staging or main); filters to `.ts`/`.tsx` excluding configs, type files, and existing tests.
2. **Read standards + patterns** — reads `standards.testing` from stack.yml; samples 1–2 existing test files to extract describe/it nesting, mock approach, assertion style.
3. **Check existing coverage** — if a test file exists, reads it and offers to add missing coverage (never overwrites).
4. **Generate** — happy path, edge cases (empty/null/boundary), error cases; AAA with explicit comments; 90% coverage target for business logic.
5. **Approval** — shows generated tests before writing; never writes without approval.
6. **Write + verify** — writes the file, runs the tests, reports pass/fail; offers to fix on failure.

## Framework

Vitest on Bun. Always imports explicitly:
```typescript
import { describe, it, expect, vi } from 'vitest'
```

## E2E mode

Checks for Playwright, uses page objects if they exist, generates `{feature}.spec.ts` files using `getByRole`/`getByLabel`/`getByText` selectors.

## Safety

- Never overwrites existing test files without explicit approval
- Never installs dependencies (informs + stops)
- Always runs tests after writing
