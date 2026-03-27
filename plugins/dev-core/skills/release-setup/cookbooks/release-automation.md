# Cookbook — Release Automation

Let:
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D✅(label) := Display: `{label} ✅ Configured`
  D⏭(label)  := Display: `{label} ⏭ Already configured`
  D⚠(label)  := Display: `{label} ⚠️ Install failed — check network/lockfile`

## Phase 4 — Release Automation

Configure automated versioning and changelog generation.

`has_releases = true` ∧ ¬F:
- D⏭("Release automation"), skip to Phase 5.

AskUserQuestion: **semantic-release** | **Release Please** | **Skip**

**semantic-release chosen:**
1. Install packages (branch on `{package_manager}`):
   ```bash
   bun:  bun add -d semantic-release @semantic-release/git @semantic-release/changelog
   pnpm: pnpm add -D semantic-release @semantic-release/git @semantic-release/changelog
   npm:  npm install --save-dev semantic-release @semantic-release/git @semantic-release/changelog
   yarn: yarn add --dev semantic-release @semantic-release/git @semantic-release/changelog
   ```
2. Determine `branches` array from `branch_list` detected in Phase 1.
   - `main` or `master` branch → plain string: `'main'`
   - Any other branch (e.g. `staging`, `develop`) → object form required by semantic-release:
     `{name: '<branch>', prerelease: true, channel: '<branch>'}`
   - Single or none detected: default to `['main']`.
3. Generate `release.config.cjs`:
   ```js
   module.exports = {
     branches: [
       'main',                                        // plain string for main
       {name: 'staging', prerelease: true, channel: 'staging'},  // object for prerelease
     ],
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
   Populate `branches` dynamically from `branch_list`: main/master → string, others → object.
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
