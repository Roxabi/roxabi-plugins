---
name: dev-checkup
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection, secret scanning, CI hardening. Triggers: "dev-checkup" | "checkup" | "health check" | "check setup" | "verify config" | "security baseline".'
version: 0.8.1
allowed-tools: Bash, Read, ToolSearch
---

# Checkup

Let:
  Σ := severity icon (❌ blocking | ⚠️ warning | ✅ pass | ⏭ skipped)
  I_TS := `../init/init.ts`
  σ := `.claude/stack.yml`
  δ := `.claude/dev-core.yml`
  D(label, result) := Display: `{label} {result}`
  Ask(opts) := present opts, wait for user reply
  chk(cond, pass, fail) := cond → ✅ pass | fail
  stackVal(key) := value read from σ
  ensureGitignore(entry) := append entry to .gitignore if missing

Run all health checks and fix issues inline — no redirects to other skills.

Severity guide: ❌ = blocking error, ⚠️ = warning, ✅ = pass, ⏭ = skipped.

## Dispatch

Phase 1 — dev-core checks → Read `cookbooks/devcore-checks.md`, execute.
Phase 2 — Stack configuration → Read `cookbooks/stack-checks.md`, execute.
Phase 3 — Workspace health → Read `cookbooks/infra-checks.md`, execute (includes Phases 3-5).

$ARGUMENTS
