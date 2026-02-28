---
name: validate
argument-hint: [--quick | --full | --affected]
description: Run all quality gates (lint, typecheck, test, env, i18n, license) and produce a structured pass/fail report. Triggers: "validate" | "check everything" | "quality check" | "pre-push check" | "are we green".
version: 0.1.0
allowed-tools: Bash, Read
---

# Validate

Let:
  χ := quality check (name, `bun run` command, timeout, result)
  σ := {✅ pass (exit 0), ❌ FAIL (exit ≠0), ⚠️ warn (exit 0 + warnings), ⏭ skip (¬in scope)}

Run all quality gates sequentially → single structured pass/fail report. ¬stop on first failure — run all χ for complete picture.

## Usage

```
/validate              → Run all checks
/validate --quick      → Lint + typecheck only (fastest)
/validate --full       → All checks including license and coverage
/validate --affected   → Only check files changed vs main
```

## Instructions

### 1. Scope

| Flag | χ set |
|------|-------|
| (none) | lint, typecheck, test, env, i18n |
| `--quick` | lint, typecheck |
| `--full` | lint, typecheck, test, test:coverage, env, i18n, license |
| `--affected` | lint (affected), typecheck:affected, test:affected |

### 2. Run χ Sequentially

∀ χ ∈ scope: run command, capture stdout+stderr + exit code. Record: name, σ, duration, error summary (first 5 error lines if failed).

**¬raw `bun test`** — always `bun run <command>`.

| χ | Command | Timeout |
|---|---------|---------|
| Lint | `bun run lint` | 60s |
| Typecheck | `bun run typecheck` | 120s |
| Typecheck (affected) | `bun run typecheck:affected` | 120s |
| Test | `bun run test` | 180s |
| Test (affected) | `bun run test:affected` | 180s |
| Test coverage | `bun run test:coverage` | 300s |
| Env check | `bun run env:check` | 10s |
| i18n | `bun run i18n:check` | 30s |
| License | `bun run license:check` | 30s |

### 3. Report

Output structured table after all χ complete:

```
Validate Report
═══════════════

  Check          │ Status │ Duration │ Notes
  Lint           │ ✅ pass │ 2.1s     │ —
  Typecheck      │ ✅ pass │ 8.3s     │ —
  Test           │ ❌ FAIL │ 12.4s    │ 2 failed, 48 passed
  Env check      │ ✅ pass │ 0.3s     │ —
  i18n           │ ⚠️ warn │ 1.1s     │ 3 missing keys in fr.json
  ─────────────────────────────────────────────
  Result: FAIL (4/5 passed, 1 failed)
  Total time: 24.2s
```

### 4. Failure Details

∃ χ with σ = ❌ → append failures section. First 10 error lines per failing χ. User re-runs individual χ for full output.

```
Failures
────────
Test:
  FAIL src/auth/login.test.ts > should validate token
    AssertionError: expected undefined to be defined
  FAIL src/api/health.test.ts > should return 200
    Error: ECONNREFUSED
```

### 5. Verdict

One-line exit summary:
- ∀ χ pass → `All checks passed. Safe to push.`
- ∃ χ fail → `{N} check(s) failed. Fix before pushing.`
- `--quick` ∧ pass → `Quick checks passed. Run /validate for full check.`

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Command not found | σ := ⚠️ warn, "command not available" |
| Command times out | σ := ❌ FAIL, "timed out after Xs" |
| No test files found | σ := ⏭ skip |
| Docker not running (env/db) | σ := ⚠️ warn, ¬fail |
| Running in worktree | No special handling needed |

## Safety Rules

1. **Read-only** — ¬modify files
2. **¬auto-fix** — report issues, user decides
3. **Run ALL χ** — ¬short-circuit on first failure
4. **`bun run`** — ¬raw `bun test` (Bun runner ≠ Vitest)

$ARGUMENTS
