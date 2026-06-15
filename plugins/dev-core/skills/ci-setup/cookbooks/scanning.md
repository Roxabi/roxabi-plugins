# Cookbook: Secret Scanning + Dependabot

Let:
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 1b — TruffleHog

Ask: **Set up TruffleHog** | **Skip**.
yes:
1. Generate `.github/workflows/secret-scan.yml`:
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
     cancel-in-progress: false   # never preempt a security scan

   jobs:
     trufflehog:
       runs-on: ubuntu-latest
       timeout-minutes: 5
       steps:
         - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
           with:
             fetch-depth: 0

         - name: TruffleHog secret scan
           uses: trufflesecurity/trufflehog@17456f8c7d042d8c82c9a8ca9e937231f9f42e26  # v3.95.2
           with:
             extra_args: --only-verified
   ```
2. Push via REST API:
   ```bash
   CONTENT=$(base64 < .github/workflows/secret-scan.yml | tr -d '\n')
   BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD)
   EXISTING_SHA=$(gh api "repos/<owner>/<repo>/contents/.github/workflows/secret-scan.yml" \
     --jq '.sha // empty') || EXISTING_SHA=""
   gh api repos/<owner>/<repo>/contents/.github/workflows/secret-scan.yml \
     --method PUT \
     --field message="ci: add standalone secret-scan.yml workflow" \
     --field content="$CONTENT" \
     --field branch="$BRANCH" \
     ${EXISTING_SHA:+--field sha="$EXISTING_SHA"}
   ```
3. Check local binary:
   ```bash
   which trufflehog 2>/dev/null && echo "installed" || echo "missing"
   ```
   missing → display:
   ```
   ⚠️  trufflehog binary not found — pre-commit hook will fail until installed.
       Install options:
         • Homebrew:       brew install trufflehog
         • GitHub release: https://github.com/trufflesecurity/trufflehog/releases
         • Docker:         docker run --rm -it trufflesecurity/trufflehog:latest
   ```
4. D✅("TruffleHog").

skip → D⏭("TruffleHog").

## Phase 1c — Dependabot

Ask: **Set up Dependabot** | **Skip**.
yes:
1. Auto-detect ecosystem from σ `package_manager`: `uv`/`pip` → `pip` | `bun`/`npm`/`pnpm`/`yarn` → `npm`. Unknown → Ask: **pip**|**npm**|**Skip**.
2. Generate `.github/dependabot.yml`:
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
       labels:
         - dependencies
         - ci
   ```
3. Push via REST API:
   ```bash
   CONTENT=$(base64 < .github/dependabot.yml | tr -d '\n')
   BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD)
   EXISTING_SHA=$(gh api "repos/<owner>/<repo>/contents/.github/dependabot.yml" \
     --jq '.sha // empty') || EXISTING_SHA=""
   gh api repos/<owner>/<repo>/contents/.github/dependabot.yml \
     --method PUT \
     --field message="chore: add dependabot.yml" \
     --field content="$CONTENT" \
     --field branch="$BRANCH" \
     ${EXISTING_SHA:+--field sha="$EXISTING_SHA"}
   ```
4. D("Dependabot", "✅ .github/dependabot.yml created (<ecosystem> + github-actions)").

skip → D⏭("Dependabot").
