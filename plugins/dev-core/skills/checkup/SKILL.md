---
name: checkup
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "checkup" | "health check" | "check setup" | "verify config".'
version: 0.7.0
allowed-tools: Bash, Read, ToolSearch
---

# Checkup

Let:
  Σ := severity icon (❌ blocking | ⚠️ warning | ✅ pass | ⏭ skipped)
  Φ := CLAUDE_PLUGIN_ROOT
  σ := `.claude/stack.yml`
  δ := `.claude/dev-core.yml`
  I_TS := `${Φ}/skills/init/init.ts`
  D(label, result) := Display: `{label} {result}`
  Ask(opts) := → DP(A)with given options
  chk(cond, pass, fail) := cond → ✅ pass | fail
  stackVal(key) := value read from σ
  ensureGitignore(entry) := append entry to .gitignore if missing

Run all health checks and fix issues inline — no redirects to other skills.

Severity guide: ❌ = blocking error, ⚠️ = warning, ✅ = pass, ⏭ = skipped.

## Dispatch

Phase 1 — dev-core checks → Read `${CLAUDE_SKILL_DIR}/cookbooks/devcore-checks.md`, execute.
Phase 2 — Stack configuration → Read `${CLAUDE_SKILL_DIR}/cookbooks/stack-checks.md`, execute.
Phase 3 — Workspace health → Read `${CLAUDE_SKILL_DIR}/cookbooks/infra-checks.md`, execute (includes Phases 3-5).

$ARGUMENTS
