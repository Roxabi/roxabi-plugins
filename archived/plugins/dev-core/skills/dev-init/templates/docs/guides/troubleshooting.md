# Troubleshooting Guide

Common issues and their solutions. Agents read this via `{standards.troubleshooting}`.

## Build Failures

<!-- Document common build issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | `Module not found: @repo/ui` | Missing turbo dependency | `bun install` in monorepo root |
  | TypeScript errors in CI but not local | Different TS version | Check `tsconfig.json` extends |
-->

TODO: Document common build failures.

## Test Failures

<!-- Document common test issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | Tests pass locally, fail in CI | Missing env vars | Check `.env.test` vs CI secrets |
  | Flaky timeout errors | MSW not intercepting | Check handler setup in `vitest.setup.ts` |
-->

TODO: Document common test failures.

## Development Environment

<!-- Document local dev issues. Examples:
  | Symptom | Cause | Fix |
  |---------|-------|-----|
  | Port 3000 already in use | Stale process | `lsof -ti:3000 | xargs kill` |
  | Prisma client out of date | Schema changed | `bunx prisma generate` |
-->

TODO: Document common dev environment issues.
