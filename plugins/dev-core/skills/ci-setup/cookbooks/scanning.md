# Cookbook: Secret Scanning + Dependabot

Let:
  σ    := `.claude/stack.yml`
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 1b — TruffleHog

**Policy:** local is **primary** (before GitHub); CI is **secondary** (filet if hooks bypassed).

| Layer | Scope | SSoT |
|-------|--------|------|
| Local lefthook | unpushed commits vs `origin/main\|staging` + staged files | `scripts/trufflehog-check.sh` + `scripts/trufflehog-exclude-paths.txt` |
| CI | PR/push **diff** only (`base`/`head`) | same exclude file |

Prefer the generator (`secret-scan.yml` in `bun $I_TS workflows`). Use this phase only when workflows were set up manually and secret-scan is still missing.

Ask: **Set up TruffleHog** | **Skip**.
yes:
1. Generate via init (recommended):
   ```bash
   bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test none --deploy none
   ```
   Ensure kit/repo has:
   - `scripts/trufflehog-check.sh` (lefthook pre-commit + pre-push)
   - `scripts/trufflehog-exclude-paths.txt` (path regex suppressions)
   - `.github/workflows/secret-scan.yml` (diff-scoped + exclude)
2. Check local binary:
   ```bash
   which trufflehog 2>/dev/null && echo "installed" || echo "missing"
   bash scripts/trufflehog-check.sh
   ```
   missing → display install options (Homebrew, GitHub release, Docker).
3. D✅("TruffleHog").

skip → D⏭("TruffleHog").

## Phase 1c — Dependabot

**Owner:** the workflows generator (`bun $I_TS workflows`) writes the full file (ecosystem + github-actions). This phase **verifies / tops up** — never treat path existence alone as complete.

Ask: **Set up Dependabot** | **Skip**.
yes:
1. Auto-detect ecosystem from σ `package_manager` / `runtime`: `uv`/`pip`/`python` → `pip` | `bun`/`npm`/`pnpm`/`yarn`/`node` → `npm`. Unknown → Ask: **pip**|**npm**|**Skip**.
2. Check content (not just path):
   ```bash
   test -f .github/dependabot.yml && \
     grep -q 'package-ecosystem: github-actions' .github/dependabot.yml && \
     grep -qE 'package-ecosystem: (npm|pip)' .github/dependabot.yml \
     && echo complete || echo incomplete
   ```
   - **complete** → D("Dependabot", "✅ Already complete (ecosystem + github-actions)"), skip write.
   - **incomplete / missing** → re-run generator (preferred) so SSOT stays single:
     ```bash
     # Prefer generator (same stack as Phase 1). --force only if intentional overwrite.
     bun $I_TS workflows --owner <owner> --repo <repo> \
       --stack <stack> --test <test> --deploy <deploy> \
       --merge <merge> --e2e <e2e> --lint <lint> --typecheck <typecheck> \
       --force   # only when topping up a partial dependabot.yml; review other workflow diffs first
     ```
     Or write the fleet shape locally when offline (must match `generateDependabotYml`):
   ```yaml
   version: 2
   updates:
     - package-ecosystem: <ecosystem>   # npm | pip
       directory: /
       schedule:
         interval: weekly
         day: monday
       open-pull-requests-limit: 10
       groups:
         minor-and-patch:
           update-types:
             - minor
             - patch
       labels:
         - dependencies

     - package-ecosystem: github-actions
       directory: /
       schedule:
         interval: weekly
         day: monday
       open-pull-requests-limit: 5
       cooldown:
         default-days: 3   # semver-*-days rejected by GitHub for github-actions
       labels:
         - dependencies
         - ci
   ```
3. `dependabot-automerge.yml` is pushed by `bun $I_TS workflows` (labels patch/minor dependabot PRs `reviewed`; semver-major excluded).
4. D("Dependabot", "✅ .github/dependabot.yml created/topped-up (<ecosystem> + github-actions)").

skip → D⏭("Dependabot").

Note: bun → Dependabot `npm` ecosystem (fleet convention). Lockfile support for `bun.lock` is GitHub-side — not re-verified here.