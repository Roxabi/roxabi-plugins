# Cookbook — Commit Standards

Let:
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D✅(label) := Display: `{label} ✅ Configured`
  D⏭(label)  := Display: `{label} ⏭ Already configured`
  D⚠(label)  := Display: `{label} ⚠️ Install failed — check network/lockfile`

## Phase 3 — Commit Standards (Node/TS only)

Configure Commitizen + commitlint for enforced conventional commits.

`runtime == python`:
- D⏭("Commit standards — Python not supported"), skip to Phase 4.

`has_commits = true` ∧ ¬F:
- D⏭("Commit standards"), skip to Phase 4.

→ DP(A): **Commitizen + commitlint** | **Skip**

**Commitizen + commitlint chosen:**
1. Install packages (branch on `{package_manager}`):
   ```bash
   bun:  bun add -d commitizen @commitlint/cli @commitlint/config-conventional
   pnpm: pnpm add -D commitizen @commitlint/cli @commitlint/config-conventional
   npm:  npm install --save-dev commitizen @commitlint/cli @commitlint/config-conventional
   yarn: yarn add --dev commitizen @commitlint/cli @commitlint/config-conventional
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
