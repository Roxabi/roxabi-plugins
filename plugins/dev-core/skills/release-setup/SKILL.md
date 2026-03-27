---
name: release-setup
argument-hint: '[--force]'
description: 'Set up commit standards and release automation — Commitizen, commitlint, semantic-release, Release Please, Lefthook/Husky. Triggers: "release setup" | "setup releases" | "commit standards" | "setup release automation".'
version: 0.1.0
allowed-tools: Bash, ToolSearch, AskUserQuestion
---

# Release Setup

Let:
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D✅(label) := Display: `{label} ✅ Configured`
  D⏭(label)  := Display: `{label} ⏭ Already configured`
  D⚠(label)  := Display: `{label} ⚠️ Install failed — check network/lockfile`

Configure commit standards and release automation: Commitizen + commitlint, hook runner (Lefthook or Husky), and semantic-release or Release Please.

Can run standalone (`/release-setup`) or be called by `/init` after `/ci-setup`.

## Phase 0 — Pre-check (idempotency)

Check prerequisites and per-component state before any installation.

1. Verify σ exists:
   ```bash
   test -f .claude/stack.yml && echo "found" || echo "missing"
   ```
   missing → warn: "stack.yml not found — release-setup reads runtime and hook runner from it."
   AskUserQuestion: **Run `/env-setup` first** | **Proceed manually**
   Proceed manually → continue with defaults (runtime: node, package_manager: npm, hooks.tool: none).

2. Check per-component config file existence in parallel:
   ```bash
   test -f .lefthook.yml && echo "has_lefthook" || echo "no_lefthook"
   test -d .husky && echo "has_husky" || echo "no_husky"
   test -f .commitlintrc.cjs && echo "has_commits" || echo "no_commits"
   test -f release.config.cjs && echo "has_sr" || echo "no_sr"
   test -f release-please-config.json && echo "has_rp" || echo "no_rp"
   ```

3. Set booleans from results:
   - `has_hook_runner` := `has_lefthook` ∨ `has_husky`
   - `has_commits` := `.commitlintrc.cjs` ∃
   - `has_releases` := `release.config.cjs` ∃ ∨ `release-please-config.json` ∃
   - `has_lefthook` := `.lefthook.yml` ∃

4. F overrides all guards → treat all booleans as false (re-run all components).

## Phase 1 — Stack Detection

Read configuration and detect environment.

1. Read σ fields: `runtime`, `package_manager`, `hooks.tool`, `commands.lint`, `commands.typecheck`.
   Defaults if σ missing: runtime=`node`, package_manager=`npm`, hooks.tool=`none`, commands.lint=`npm run lint`, commands.typecheck=`npm run typecheck`.

2. Detect existing hook runner via file checks:
   ```bash
   test -f .lefthook.yml && echo "lefthook" || (test -d .husky && echo "husky" || echo "none")
   ```

3. Detect branches:
   ```bash
   git branch -r | grep -E 'staging|develop|main|master'
   ```
   Store as `branch_list`. Default to `['main']` if only one or none detected.

## Dispatch

Phase 2 — Hook Runner → Read `${CLAUDE_SKILL_DIR}/cookbooks/hook-runner.md`, execute.
Phase 3 — Commit Standards → Read `${CLAUDE_SKILL_DIR}/cookbooks/commit-standards.md`, execute.
Phase 4 — Release Automation → Read `${CLAUDE_SKILL_DIR}/cookbooks/release-automation.md`, execute.
Phase 5 — Summary (below).

## Phase 5 — Summary (no auto-commit)

Display results and generated files. Do NOT run `git add` or `git commit`.

1. Display summary table:

   ```
   Release Setup Complete
   ======================

     Hook runner         ✅ Configured / ⏭ Already configured / ⏭ Skipped
     Commit standards    ✅ Configured / ⏭ Already configured / ⏭ Python not supported / ⏭ Skipped
     Release automation  ✅ Configured / ⏭ Already configured / ⏭ Skipped
   ```

2. List generated files (only those actually written):

   ```
   Generated files:
     .lefthook.yml
     .pre-commit-config.yaml       (Python only)
     .husky/pre-commit             (Husky only)
     .husky/commit-msg             (Husky + Commitizen)
     .commitlintrc.cjs             (Commitizen chosen)
     release.config.cjs            (semantic-release chosen)
     release-please-config.json    (Release Please chosen)
     .release-please-manifest.json (Release Please chosen)
   ```

3. Display suggested commit command:
   ```
   Suggested commit:
     git add <generated-files>
     git commit -m "chore: add release setup"
   ```

## Safety Rules

1. **Never push to remote** without user confirmation
2. **Always AskUserQuestion** before installing packages or writing config files
3. **Idempotent** — skip already-configured components unless F
4. **No auto-commit** — sub-skill pattern: display files, let user review and commit

$ARGUMENTS
