# Cookbook — Hook Runner

Let:
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D✅(label) := Display: `{label} ✅ Configured`
  D⏭(label)  := Display: `{label} ⏭ Already configured`
  D⚠(label)  := Display: `{label} ⚠️ Install failed — check network/lockfile`

## Phase 2 — Hook Runner

Install or skip hook runner setup.

`has_hook_runner = true` ∧ ¬F:
- Note: existing hook runner detected (`.lefthook.yml` or `.husky/`) — will add `commit-msg` hook entry in Phase 3 if Commitizen chosen.
- Skip install step; proceed to Phase 3.

`has_hook_runner = false` ∨ F:
→ DP(A): **Lefthook** | **Husky** | **Skip**

**Lefthook chosen, runtime = node/bun/deno (Node/TS):**
1. Install (branch on `{package_manager}`):
   ```bash
   bun:  bun add -d lefthook
   pnpm: pnpm add -D lefthook
   npm:  npm install --save-dev lefthook
   yarn: yarn add --dev lefthook
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
   bun:  bun add -d lint-staged
   pnpm: pnpm add -D lint-staged
   npm:  npm install --save-dev lint-staged
   yarn: yarn add --dev lint-staged
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
1. Check system install (Lefthook is a Go binary — not installable via Python PM):
   ```bash
   which lefthook && echo "found" || echo "missing"
   ```
   `missing` → display instructions and continue:
   ```
   Lefthook must be installed as a system binary:
     brew install lefthook        # macOS / Homebrew
     go install github.com/evilmartians/lefthook@latest  # Go toolchain
     scoop install lefthook       # Windows
   Install lefthook then re-run /release-setup.
   ```
   D⚠("Hook runner — lefthook not found") + skip to Phase 3.
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
1. Install `husky` (branch on `{package_manager}`):
   ```bash
   bun:  bun add -d husky
   pnpm: pnpm add -D husky
   npm:  npm install --save-dev husky
   yarn: yarn add --dev husky
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
   bun:  bun add -d lint-staged
   pnpm: pnpm add -D lint-staged
   npm:  npm install --save-dev lint-staged
   yarn: yarn add --dev lint-staged
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
