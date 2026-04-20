---
name: test
argument-hint: [file | --e2e | --run]
description: Generate/run unit, integration & Playwright e2e tests. Triggers: "test this file" | "write tests" | "add coverage" | "run tests" | "e2e tests" | "add tests" | "test coverage" | "generate tests" | "test this" | "write unit tests" | "add integration tests".
version: 0.4.0
allowed-tools: Bash, Read, Write, Glob, Grep, ToolSearch
---

# Test

## Success

I := π written ∧ test passes
V := `{commands.test} {test_file}` → exit 0

Let:
  τ := target file(s) under test
  π := test file adjacent to source (`{name}.test.ts` | `{name}.spec.ts` | `__tests__/{name}.test.ts`)
  Σ := `{standards.testing}`

Generate tests for changed/specified files. Follow existing codebase patterns.

## Usage

```
/test                      → Generate tests for files changed vs base branch
/test src/auth/login.ts    → Generate tests for a specific file
/test --e2e                → Generate Playwright e2e tests for changed files
/test --run                → Run existing tests ({commands.test})
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | run-shortcut | — | `{commands.test}` exit 0 | `--run` flag only |
| 2 | identify-targets | ✓ | Δ files listed | — |
| 3 | read-standards | ✓ | Σ read | — |
| 4 | check-coverage | ✓ | π ∃? | — |
| 5 | generate-tests | ✓ | tests generated | — |
| 6 | approval | ✓ | user confirms | — |
| 7 | write-and-verify | ✓ | test exit 0 | retry 1 |

## Pre-flight

Success: π written ∧ test passes
Evidence: `{commands.test} {test_file}` exit 0
Steps: identify-targets → read-standards → check-coverage → generate-tests → approval → write-and-verify
¬clear → STOP + ask: "Which file(s) need tests?"

## Step 1 — `--run` Shortcut

`--run` ⇒ `{commands.test}` → report results → stop.

## Step 2 — Identify Target Files

```bash
BASE=$(git branch -r | grep -q 'origin/staging' && echo staging || echo main)
git diff ${BASE}...HEAD --name-only
```

Include: `.ts`, `.tsx`. Exclude: `*.config.ts`, `*.d.ts`, `*.test.*`, `*.spec.*`, files with no exports.
Specific file arg ⇒ use directly. ¬testable τ ⇒ inform + stop.

## Step 3 — Read Standards + Find Patterns

Read Σ before generating — contains framework config, AAA requirements, mocking strategies, coverage targets.

Glob `*.test.ts` / `*.spec.ts` near τ → read 1–2 examples → extract: describe/it nesting, mock approach, assertion style, naming.

**Framework:** Vitest on Bun. Always import explicitly:
```typescript
import { describe, it, expect, vi } from 'vitest'
```

**Bun compat constraints:**

| Avoid | Use instead |
|-------|------------|
| `vi.mocked(fn)` | `fn as ReturnType<typeof vi.fn>` |
| `vi.stubGlobal('fetch', mock)` | `globalThis.fetch = mock as typeof fetch` |
| `vi.stubGlobal('Bun', {...})` | `vi.spyOn(Bun, 'spawn').mockImplementation(...)` |
| `vi.restoreAllMocks()` in `beforeEach` | `vi.clearAllMocks()` |

Mock factory hoisting: Bun validates `vi.mock` factories against real module at hoist time. Side-effectful imports run before `process.env` assignments. Fix: `vi.mock('../../shared/config', factory)` to intercept directly.

## Step 4 — Check Existing Coverage

∀ τ → check for π. ∃ π ⇒ read, compare with source exports, offer to add missing coverage (¬overwrite). ¬π ⇒ generate full test file.

## Step 5 — Generate Tests

∀ τ:
1. Read source → understand exports, signatures, types, behavior
2. Generate: happy path, edge cases (empty/null/boundary), error cases
3. Structure using AAA with explicit comments:

```typescript
it('should return user by id', () => {
  // Arrange
  const userId = 'abc-123'
  // Act
  const result = getUser(userId)
  // Assert
  expect(result).toBeDefined()
})
```

4. Coverage targets: 90% business logic | 80% controllers/modules | 70% overall
5. Follow discovered patterns exactly
6. Place adjacent to source: `login.ts` → `login.test.ts`

## Step 6 — Approval

→ DP(A) **Approve and write all** | **Approve with modifications** | **Skip specific files**
¬write without approval.

## Step 7 — Write + Verify

∀ approved τ: write via Write tool → `{commands.test} {test_file_path}` → report pass/fail.
∃ failures ⇒ → DP(A) show failing test + error → propose fix → re-run.

## E2E Mode (`--e2e`)

Check Playwright:
```bash
bunx playwright --version 2>/dev/null
```
¬installed ⇒ inform install command for `{package_manager}`:
- bun: `bun add -d @playwright/test && bunx playwright install`
- pnpm: `pnpm add -D @playwright/test && pnpm exec playwright install`
- npm: `npm install --save-dev @playwright/test && npx playwright install`
- yarn: `yarn add --dev @playwright/test && yarn playwright install`
Stop (¬install deps).

E2E dir: `{frontend.path}/e2e/` (fall back to `e2e/` if `{frontend.path}` not set).
Check existing patterns first. Name: `{feature}.spec.ts`.
Follow approval + verification flow (Steps 6–7).

## Playwright Patterns

∃ page objects in `{frontend.path}/e2e/` → follow them.

```typescript
// e2e/pages/login.page.ts
import { type Page, type Locator } from '@playwright/test'

export class LoginPage {
  readonly emailInput: Locator
  readonly passwordInput: Locator
  readonly submitButton: Locator

  constructor(readonly page: Page) {
    this.emailInput = page.getByLabel('Email')
    this.passwordInput = page.getByLabel('Password')
    this.submitButton = page.getByRole('button', { name: 'Sign in' })
  }

  async goto() { await this.page.goto('/login') }
  async login(email: string, password: string) {
    await this.emailInput.fill(email)
    await this.passwordInput.fill(password)
    await this.submitButton.click()
  }
}
```

```typescript
// e2e/auth/login.spec.ts
import { test, expect } from '@playwright/test'
import { LoginPage } from '../pages/login.page'

test.describe('Login flow', () => {
  test('should login with valid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.login('user@example.com', 'password123')
    await expect(page).toHaveURL('/dashboard')
  })
})
```

Selectors: `page.getByRole()`, `page.getByLabel()`, `page.getByText()` (¬`page.locator('css')` unless no semantic alternative).

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| File has no exports | Skip, inform user |
| Tests already exist | Offer to add missing coverage, ¬overwrite |
| Test framework not detected | → DP(B) which framework to use |
| `--run` flag | Run `{commands.test}` and report only |
| React component | Generate component tests with appropriate render approach |
| File in monorepo package | Place tests relative to package, ¬root |

## Safety Rules

1. ¬overwrite existing test files without explicit approval
2. ¬install dependencies — inform + stop
3. Always present generated tests for approval before writing
4. Always run tests after writing
5. Always match existing patterns — ¬impose different style

$ARGUMENTS
