# Cookbook: Secret Scanning + Dependabot

Let:
  σ    := `.claude/stack.yml`
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 1b — TruffleHog

Prefer the generator (`secret-scan.yml` is included in `bun $I_TS workflows`). Use this phase only when workflows were set up manually and secret-scan is still missing.

Ask: **Set up TruffleHog** | **Skip**.
yes:
1. Generate via init (recommended):
   ```bash
   bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test none --deploy none
   ```
   Or push standalone `secret-scan.yml` (SHA-pinned — fleet consensus):
   ```yaml
   name: Secret Scan

   permissions:
     contents: read

   on:
     push:
       branches: [main, staging]
     pull_request:
       branches: [main, staging]
     workflow_dispatch: {}

   concurrency:
     group: secret-scan-${{ github.ref }}
     cancel-in-progress: false

   jobs:
     trufflehog:
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10  # v6
           with:
             fetch-depth: 0
         - name: TruffleHog secret scan
           uses: trufflesecurity/trufflehog@47e7b7cd74f578e1e3145d48f669f22fd1330ca6  # v3.94.3
           with:
             extra_args: --only-verified
   ```
2. Check local binary:
   ```bash
   which trufflehog 2>/dev/null && echo "installed" || echo "missing"
   ```
   missing → display install options (Homebrew, GitHub release, Docker).
3. D✅("TruffleHog").

skip → D⏭("TruffleHog").

## Phase 1c — Dependabot

Ask: **Set up Dependabot** | **Skip**.
yes:
1. Auto-detect ecosystem from σ `package_manager`: `uv`/`pip` → `pip` | `bun`/`npm`/`pnpm`/`yarn` → `npm`. Unknown → Ask: **pip**|**npm**|**Skip**.
2. Generate `.github/dependabot.yml` (github-actions block always included; 72h cooldown on fleet):
   ```yaml
   version: 2
   updates:
     - package-ecosystem: <ecosystem>
       directory: /
       schedule:
         interval: weekly
         day: monday
       open-pull-requests-limit: 10
       groups:
         minor-and-patch:
           update-types: [minor, patch]
       labels:
         - dependencies

     - package-ecosystem: github-actions
       directory: /
       schedule:
         interval: weekly
         day: monday
       open-pull-requests-limit: 5
       cooldown:
         default-days: 3
         semver-major-days: 3
         semver-minor-days: 3
         semver-patch-days: 3
       labels:
         - dependencies
         - ci
   ```
3. `dependabot-automerge.yml` is pushed by `bun $I_TS workflows` (labels patch/minor dependabot PRs `reviewed`; semver-major excluded).
4. D("Dependabot", "✅ .github/dependabot.yml created (<ecosystem> + github-actions)").

skip → D⏭("Dependabot").