---
title: "Example: Micro-Task Generation"
description: Shows how Breadboard affordances expand into micro-tasks
---

## Example Spec Input

A spec with these Breadboard affordances:

```
| ID | Handler | Wiring | Logic |
|----|---------|--------|-------|
| N1 | Auth validator | Req -> N1 -> S1 | Validate JWT, extract user |
| N2 | Profile fetcher | N1 -> N2 -> S2 | Fetch user profile from DB |
```

```
| ID | Store | Type |
|----|-------|------|
| S1 | JWT secret | Config |
| S2 | User profiles table | Persistent (DB) |
```

And Slices:

```
| Slice | Description | Affordances |
|-------|-------------|-------------|
| V1 | Auth + profile fetch | N1, N2, S1, S2 |
```

## Generated Micro-Tasks

> **Ordering note:** Tasks are listed in execution order: RED (test tasks) first, then RED-GATE sentinel, then GREEN (implementation tasks). Within each phase, data stores (S*) come before code handlers (N*) and CLI/UI (U*).

### Slice V1: Auth + profile fetch

#### Task 1: Write auth guard tests → tester
- **File:** `apps/api/src/auth/jwt.guard.test.ts`
- **Snippet:** `describe('JwtGuard', () => { it('should validate token', ...) })`
- **Verify:** `grep -q 'describe.*JwtGuard' apps/api/src/auth/jwt.guard.test.ts` (ready)
- **Expected:** Test file contains expected describe/it blocks
- **Time:** 3 min
- **Difficulty:** 2
- **Traces:** N1
- **Phase:** RED

#### Task 2: Write profile service tests → tester
- **File:** `apps/api/src/users/users.service.test.ts`
- **Snippet:** `describe('UsersService', () => { it('should fetch profile', ...) })`
- **Verify:** `grep -q 'describe.*UsersService' apps/api/src/users/users.service.test.ts` (ready)
- **Expected:** Test file contains expected describe/it blocks
- **Time:** 3 min
- **Difficulty:** 2
- **Traces:** N2
- **Phase:** RED

#### RED-GATE: RED complete V1 → tester
- **Verify:** All test tasks for V1 marked complete
- **Phase:** RED-GATE

#### Task 3: Create user profiles schema [P] → backend-dev
- **File:** `apps/api/src/users/schema.ts`
- **Snippet:** `export const usersTable = pgTable('users', { id: text('id').primaryKey(), ... })`
- **Verify:** `bun run typecheck --filter=@repo/api` (ready)
- **Expected:** No type errors
- **Time:** 3 min
- **Difficulty:** 2
- **Traces:** S2
- **Phase:** GREEN

#### Task 4: Add JWT validation middleware → backend-dev
- **File:** `apps/api/src/auth/jwt.guard.ts`
- **Snippet:** `@Injectable() export class JwtGuard implements CanActivate { ... }`
- **Verify:** `bun run test apps/api/src/auth/jwt.guard.test.ts` (deferred)
- **Expected:** JWT validation passes for valid tokens, rejects invalid
- **Time:** 5 min
- **Difficulty:** 3
- **Traces:** N1, S1
- **Phase:** GREEN

#### Task 5: Implement profile fetcher service → backend-dev
- **File:** `apps/api/src/users/users.service.ts`
- **Snippet:** `async getProfile(userId: string): Promise<UserProfile> { ... }`
- **Verify:** `bun run test apps/api/src/users/users.service.test.ts` (deferred)
- **Expected:** Returns user profile for valid ID, throws for invalid
- **Time:** 4 min
- **Difficulty:** 3
- **Traces:** N2, S2
- **Phase:** GREEN

> **Pre-#283:** The orchestrator manages RED-GATE ordering by spawning GREEN agents only after the tester completes RED tasks for each slice. Post-#283: Agents check the sentinel task status directly via TaskList.

## TaskCreate Metadata Example

Task 4 (JWT validation middleware) would produce:

```json
{
  "taskDifficulty": 3,
  "verificationCommand": "bun run test apps/api/src/auth/jwt.guard.test.ts",
  "verificationStatus": "deferred",
  "expectedOutput": "JWT validation passes for valid tokens, rejects invalid",
  "estimatedMinutes": 5,
  "parallel": false,
  "specTrace": "N1, S1",
  "slice": "V1",
  "phase": "GREEN"
}
```

## Parallelization Analysis

> This analysis is illustrative, covering key conflict patterns (file overlap, import inference, test independence). A complete analysis would check all N×(N-1)/2 pairs within the slice.

- Task 3 (schema) and Task 1 (auth tests): different files, no import overlap → both `[P]`
- Task 4 (auth guard) imports from Task 3's schema indirectly (N1→S1 wiring) → not parallel with Task 3
- Task 5 depends on Task 3 (N2→S2 wiring) → not parallel with Task 3
- Task 1 and Task 2: different test files, no overlap → both `[P]`

## Fallback Mode Example

A pre-#281 spec with Success Criteria (no Breadboard/Slices):

```
## Success Criteria

- [ ] SC-1: User can reset password via email link
- [ ] SC-2: Reset token expires after 24 hours
```

### Generated Micro-Tasks (Fallback)

#### Criteria SC-1: User can reset password via email link

##### Task 1: Write password reset request test → tester
- **File:** `apps/api/src/auth/password-reset.test.ts`
- **Snippet:** `describe('PasswordReset', () => { it('should send reset email', ...) })`
- **Verify:** `grep -q 'describe.*PasswordReset' apps/api/src/auth/password-reset.test.ts` (ready)
- **Expected:** Test file contains expected describe/it blocks
- **Time:** 3 min
- **Difficulty:** 2
- **Traces:** SC-1
- **Phase:** RED

##### Task 2: Implement password reset endpoint → backend-dev
- **File:** `apps/api/src/auth/password-reset.service.ts`
- **Snippet:** `async requestReset(email: string): Promise<void> { ... }`
- **Verify:** `bun run test apps/api/src/auth/password-reset.test.ts` (deferred)
- **Expected:** Reset email sent for valid user
- **Time:** 5 min
- **Difficulty:** 3
- **Traces:** SC-1
- **Phase:** GREEN

#### Criteria SC-2: Reset token expires after 24 hours

##### Task 3: Write token expiry test → tester
- **File:** `apps/api/src/auth/password-reset.test.ts`
- **Snippet:** `it('should reject expired token', () => { ... })`
- **Verify:** `grep -q 'expired token' apps/api/src/auth/password-reset.test.ts` (ready)
- **Expected:** Test file contains expiry test
- **Time:** 2 min
- **Difficulty:** 2
- **Traces:** SC-2
- **Phase:** RED

##### Task 4: Add token expiry validation → backend-dev
- **File:** `apps/api/src/auth/password-reset.service.ts`
- **Snippet:** `if (token.createdAt < Date.now() - 24 * 60 * 60 * 1000) throw new TokenExpiredError()`
- **Verify:** `bun run test apps/api/src/auth/password-reset.test.ts` (deferred)
- **Expected:** Expired token rejected with error
- **Time:** 3 min
- **Difficulty:** 2
- **Traces:** SC-2
- **Phase:** GREEN
