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

## Phase 2 — Hook Runner

Install or skip hook runner setup.

`has_hook_runner = true` ∧ ¬F:
- Note: existing hook runner detected (`.lefthook.yml` or `.husky/`) — will add `commit-msg` hook entry in Phase 3 if Commitizen chosen.
- Skip install step; proceed to Phase 3.

`has_hook_runner = false` ∨ F:
AskUserQuestion: **Lefthook** | **Husky** | **Skip**

**Lefthook chosen, runtime = node/bun/deno (Node/TS):**
1. Install:
   ```bash
   <package_manager> add -d lefthook
   ```
2. Generate `.lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>
   ```
3. Install hooks: `bunx lefthook install` (or `npx lefthook install` for npm/node).
4. Install `lint-staged`, add config to `package.json`:
   ```bash
   <package_manager> add -d lint-staged
   ```
   Add to `package.json`:
   ```json
   "lint-staged": {
     "*.{ts,tsx,js,jsx}": ["<commands.lint>"]
   }
   ```
5. Install failure → D⚠("Hook runner") + continue to Phase 3.
6. D✅("Hook runner — .lefthook.yml")

**Lefthook chosen, runtime = python:**
1. Install:
   ```bash
   <package_manager> add -d lefthook
   ```
2. Generate `.lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       pre-commit:
         run: pre-commit run --all-files
   ```
3. Generate `.pre-commit-config.yaml`:
   ```yaml
   repos:
     - repo: local
       hooks:
         - id: ruff
           name: ruff
           language: python
           entry: ruff check
           types: [python]
         - id: mypy
           name: mypy
           language: python
           entry: mypy
           types: [python]
   ```
4. Install hooks: `bunx lefthook install` (or appropriate for package_manager).
5. Install failure → D⚠("Hook runner") + continue to Phase 3.
6. D✅("Hook runner — .lefthook.yml + .pre-commit-config.yaml")

**Husky chosen:**
1. Install `husky`:
   ```bash
   <package_manager> add -d husky
   ```
2. Init: `bunx husky init` (or `npx husky init` for npm/node).
3. Generate `.husky/pre-commit`:
   ```sh
   #!/bin/sh
   <commands.lint>
   <commands.typecheck>
   ```
4. Install `lint-staged`, add config to `package.json`:
   ```bash
   <package_manager> add -d lint-staged
   ```
   Add to `package.json`:
   ```json
   "lint-staged": {
     "*.{ts,tsx,js,jsx}": ["<commands.lint>"]
   }
   ```
5. Install failure → D⚠("Hook runner") + continue to Phase 3.
6. D✅("Hook runner — .husky/")

**Skip:** D⏭("Hook runner")

## Phase 3 — Commit Standards (Node/TS only)

Configure Commitizen + commitlint for enforced conventional commits.

`runtime == python`:
- D⏭("Commit standards — Python not supported"), skip to Phase 4.

`has_commits = true` ∧ ¬F:
- D⏭("Commit standards"), skip to Phase 4.

AskUserQuestion: **Commitizen + commitlint** | **Skip**

**Commitizen + commitlint chosen:**
1. Install packages:
   ```bash
   <package_manager> add -d commitizen @commitlint/cli @commitlint/config-conventional
   ```
2. Generate `.commitlintrc.cjs`:
   ```js
   module.exports = {extends: ['@commitlint/config-conventional']}
   ```
3. Add `"commit": "cz"` to `package.json` scripts.
4. Wire commit-msg hook:
   - `has_lefthook = true` ∨ Lefthook was installed in Phase 2:
     Append `commit-msg` entry to `.lefthook.yml`:
     ```yaml
     commit-msg:
       commands:
         commitlint:
           run: commitlint --edit {1}
     ```
   - Husky ∃ (`.husky/` dir exists) ∨ Husky was installed in Phase 2:
     Generate `.husky/commit-msg`:
     ```sh
     #!/bin/sh
     npx --no -- commitlint --edit $1
     ```
5. Install failure → D⚠("Commit standards") + continue to Phase 4.
6. D✅("Commit standards — .commitlintrc.cjs")

**Skip:** D⏭("Commit standards")

## Phase 4 — Release Automation

Configure automated versioning and changelog generation.

`has_releases = true` ∧ ¬F:
- D⏭("Release automation"), skip to Phase 5.

AskUserQuestion: **semantic-release** | **Release Please** | **Skip**

**semantic-release chosen:**
1. Install packages:
   ```bash
   <package_manager> add -d semantic-release @semantic-release/git @semantic-release/changelog
   ```
2. Determine `branches` array from `branch_list` detected in Phase 1.
   - Multiple branches detected (e.g. main + staging): include all in branches config.
   - Single or none detected: default to `['main']`.
3. Generate `release.config.cjs`:
   ```js
   module.exports = {
     branches: <branches_array>,
     plugins: [
       '@semantic-release/commit-analyzer',
       '@semantic-release/release-notes-generator',
       '@semantic-release/changelog',
       '@semantic-release/npm',
       '@semantic-release/git',
       '@semantic-release/github',
     ],
   }
   ```
4. Add `"release": "semantic-release"` to `package.json` scripts.
5. Install failure → D⚠("Release automation") + continue to Phase 5.
6. D✅("Release automation — semantic-release")

**Release Please chosen:**
1. Determine `package_type`: `python` → `"python"` | else → `"node"`.
2. Generate `release-please-config.json`:
   ```json
   {
     "release-type": "<package_type>",
     "packages": {
       ".": {}
     }
   }
   ```
3. Generate `.release-please-manifest.json`:
   ```json
   {}
   ```
4. D✅("Release automation — Release Please")

**Skip:** D⏭("Release automation")

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
