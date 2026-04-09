# validate

Run all quality gates (lint, typecheck, test, env, i18n, license) and produce a structured pass/fail report.

## Why

Before a code review, you want a single command that runs every quality check and tells you exactly what's broken — without stopping at the first failure. `/validate` runs all checks sequentially, shows durations and failure details, and gives a clear verdict: safe to push or not.

## Usage

```
/validate              Run all checks (lint, typecheck, test, env, i18n)
/validate --quick      Lint + typecheck only (fastest)
/validate --full       All checks including license and coverage
/validate --affected   Only check files changed vs main
```

Triggers: `"validate"` | `"check everything"` | `"quality check"` | `"pre-push check"` | `"are we green"`

## How it works

All commands come from `stack.yml` (`commands.*`) — never raw runners.

1. **Scope** — selects which checks to run based on flags.
2. **Run sequentially** — continues even on failure (complete picture).
3. **Report** — table with check name, status (✅/❌/⚠️/⏭), duration, notes.
4. **Failure details** — first 10 error lines per failing check.
5. **Verdict** — `All checks passed. Safe to push.` or `{N} check(s) failed. Fix before pushing.`

## Checks

| Check | Command | Timeout |
|-------|---------|---------|
| Lint | `commands.lint` | 60s |
| Typecheck | `commands.typecheck` | 120s |
| Test | `commands.test` | 180s |
| Test coverage | `{pm} run test:coverage` | 300s |
| Env check | `{pm} run env:check` | 10s |
| i18n | `{pm} run i18n:check` | 30s |
| License | `{pm} run license:check` | 30s |

## Safety

- Read-only — never modifies files
- Never auto-fixes — reports issues, user decides

## Chain position

**Predecessor:** `/ci-watch` | **Successor:** `/code-review`
