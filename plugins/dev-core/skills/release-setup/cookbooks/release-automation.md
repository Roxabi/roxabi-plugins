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

→ DP(A): **semantic-release** | **Release Please** | **Skip**

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

**Tag convention (Roxabi standard — Convention A):** all tags follow `<component>/vX.Y.Z` — single-package and multi-package repos alike. Tags become self-identifying when consumed across repos (e.g. `tag = "voicecli/v1.0.0"` in a downstream pyproject.toml). Existing plain `vX.Y.Z` tags are left untouched; the new convention applies to all future releases.

1. Determine `package_type`: `python` → `"python"` | else → `"node"`.
2. Determine `repo_name`: read from `package.json .name`, `pyproject.toml [project].name`, or derive from `git config --get remote.origin.url` (strip `.git`, take basename) as fallback.
3. Determine `latest_tag_version`:
   ```bash
   git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/^v//'
   # or, if the repo already uses <component>/vX.Y.Z:
   git tag -l "${repo_name}/v*" --sort=-v:refname | head -1 | sed "s|^${repo_name}/v||"
   ```
   Fall back to `0.0.0` if neither pattern matches.
4. Generate `release-please-config.json`. Set `target-branch` to the release branch (typically `main`), and set `component` + `package-name` + `tag-separator: "/"` on the root package so tags normalize to `<name>/vX.Y.Z`:
   ```json
   {
     "release-type": "<package_type>",
     "target-branch": "main",
     "packages": {
       ".": {
         "component": "<repo_name>",
         "package-name": "<repo_name>",
         "tag-separator": "/"
       }
     }
   }
   ```
   Multi-package (uv workspace, monorepo): add one entry per package with the same three fields; also set top-level `"separate-pull-requests": true` so each package releases independently.
5. Generate `.release-please-manifest.json`. **Seed with `latest_tag_version`** — an empty `{}` causes release-please to ignore existing tags on first run and propose incorrect versions (`v0.2.0` instead of `v0.3.0` after an existing `v0.2.0` tag):
   ```json
   {
     ".": "<latest_tag_version>"
   }
   ```
6. Generate `.github/workflows/release-please.yml` (the runner — config alone is a no-op). **`target-branch: main` MUST be passed as an action input** — release-please-action v4 reads it from its own `with:` block, not the config file. Without it, the action falls back to the repo's default branch (typically `staging` in the staging→main flow) and opens release PRs on the wrong branch:
   ```yaml
   name: release-please

   on:
     push:
       branches:
         - main

   permissions:
     contents: write
     pull-requests: write

   jobs:
     release-please:
       runs-on: ubuntu-latest
       steps:
         - uses: googleapis/release-please-action@v4
           with:
             config-file: release-please-config.json
             manifest-file: .release-please-manifest.json
             target-branch: main
             token: ${{ secrets.PAT }}
   ```
   `mkdir -p .github/workflows` first. Use `secrets.PAT` (set during `/init` Phase 3) so the release PR can trigger `ci.yml` — the default `GITHUB_TOKEN` can't fan out to other workflows. Existing file + ¬F → skip with D⏭. `.github/workflows/release-please.yml` already present, but no config → restore config and keep workflow.

7. **Idempotent repair under F** — if any of these are already present but drift from the convention, patch in place:
   - Workflow missing `target-branch: main` action input → inject it.
   - Config `.` package missing `component` / `package-name` / `tag-separator: "/"` → add them.
   - Manifest is `{}` but tags exist → seed with `latest_tag_version`.
   These three are the highest-impact drifts and were the source of every release-please bug caught on Roxabi repos so far.

8. D✅("Release automation — Release Please (config + workflow)")

**Skip:** D⏭("Release automation")
