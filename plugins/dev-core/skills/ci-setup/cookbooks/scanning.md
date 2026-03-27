# Cookbook: Secret Scanning + Dependabot

Let:
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 1b — TruffleHog

Ask: **Set up TruffleHog** | **Skip**.
yes:
1. CI workflow includes `secrets` job with `trufflesecurity/trufflehog@main` (`--only-verified`).
2. Check local binary:
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
3. D✅("TruffleHog").

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
   CONTENT=$(base64 -w0 .github/dependabot.yml 2>/dev/null || base64 .github/dependabot.yml)
   gh api repos/<owner>/<repo>/contents/.github/dependabot.yml \
     --method PUT \
     --field message="chore: add dependabot.yml" \
     --field content="$CONTENT"
   ```
4. D("Dependabot", "✅ .github/dependabot.yml created (<ecosystem> + github-actions)").

skip → D⏭("Dependabot").
