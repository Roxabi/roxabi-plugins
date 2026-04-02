---
name: ci-setup
argument-hint: '[--force]'
description: 'Set up CI/CD — GitHub Actions workflows, TruffleHog, Dependabot, pre-commit hooks, marketplace plugins. Triggers: "ci setup" | "setup ci" | "configure ci" | "setup hooks" | "setup github actions".'
version: 0.1.0
allowed-tools: Bash, Read, ToolSearch
---

# CI Setup

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  Φ    := CLAUDE_PLUGIN_ROOT
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

Configure CI/CD pipelines and local safety nets: GitHub Actions workflows, secret scanning, dependency updates, pre-commit hooks, and marketplace plugins.

Can run standalone (`/ci-setup`) or be called by `/init`.

## Dispatch

Phase 1 — GitHub Actions Workflows → Read `${CLAUDE_SKILL_DIR}/cookbooks/workflows.md`, execute.
Phase 1b–1d — Secret Scanning + Dependabot → Read `${CLAUDE_SKILL_DIR}/cookbooks/scanning.md`, execute.
Phase 2 — Pre-commit Hooks → Read `${CLAUDE_SKILL_DIR}/cookbooks/hooks.md`, execute.
Phase 3 — Marketplace Plugins → Read `${CLAUDE_SKILL_DIR}/cookbooks/marketplace.md`, execute.
Phase 4 — Report (below).

## Phase 4 — Report

```
CI Setup Complete
=================

  CI/CD workflows   ✅ Created / ✅ Already configured / ⏭ Skipped
  TruffleHog        ✅ Secret scanning configured / ⏭ Skipped
  Dependabot        ✅ .github/dependabot.yml created / ⏭ Skipped
  Fumadocs Vercel   ✅ Created / ⏭ Skipped / ⏭ Not configured
  Pre-commit hooks  ✅ lefthook installed / ✅ pre-commit installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped
  License checker   ✅ tools/licenseChecker.ts copied (JS) / ✅ tools/license_check.py copied (Python) / ⏭ Skipped
  License policy    ✅ .license-policy.json created (N packages) / ✅ All compliant / ⏭ Skipped / ⏭ pip-licenses missing
  Marketplace       ✅ N plugins installed (name, name, ...) / ⏭ Skipped
```

## Safety Rules

1. **Never push to remote** without user confirmation
2. **Always present decisions via protocol** before installing hooks or plugins
3. **Idempotent** — skip already-configured items unless F

$ARGUMENTS
