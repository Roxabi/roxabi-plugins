---
name: ci-setup
argument-hint: '[--force]'
description: 'Set up CI/CD — GitHub Actions workflows, TruffleHog, Dependabot, pre-commit hooks, marketplace plugins. Triggers: "ci setup" | "setup ci" | "configure ci" | "setup hooks" | "setup github actions".'
version: 0.1.0
allowed-tools: Bash, ToolSearch, AskUserQuestion
---

# CI Setup

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  Φ    := CLAUDE_PLUGIN_ROOT
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

Configure CI/CD pipelines and local safety nets: GitHub Actions workflows, secret scanning, dependency updates, pre-commit hooks, and marketplace plugins.

Can run standalone (`/ci-setup`) or be called by `/init`.

## Phase 1 — GitHub Actions Workflows

Set up GitHub Actions via REST API (no local git). Runs from σ values.

Standard set: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

1. Discover owner/repo:
   ```bash
   gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'
   ```

2. Check existing via REST:
   ```bash
   gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
   ```
   All present → D("CI/CD workflows", "✅ Already configured"), skip.

3. Auto-detect from σ: `stack` ← `runtime`, `test` ← `commands.test` (vitest→Vitest, jest→Jest, pytest→Pytest, else→None), `deploy` ← `deploy.platform`.

4. ∃ missing → Ask: **Set up CI/CD** | **Skip**.

5. yes:
   - Ask stack (pre-select detected): **Bun** | **Node** | **Python (uv)**
   - Ask test (pre-select): **Vitest** | **Jest** | **Pytest** | **None**
   - Ask deploy (pre-select): **Vercel** | **None**
   - Run: `bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy>`
   - `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Enable auto-merge: `gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true`
   - Re-trigger open PRs with `reviewed` label:
     ```bash
     for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
       gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
       gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
     done
     ```
   - D: `CI/CD workflows ✅ Created` + `PAT secret ✅ Set` + `allow_auto_merge ✅ Enabled` + `Auto-merge re-triggered on N PR(s) ✅` (or ⏭ if none).

6. skip → D⏭("CI/CD workflows").

### Phase 1b — TruffleHog

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

### Phase 1c — Dependabot

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

### Phase 1d — Fumadocs Vercel Deployment (Optional)

Run only if `deploy.platform: vercel` ∧ `docs.framework: fumadocs` in σ.

1. `apps/docs/vercel.json` ∃ → D("Fumadocs Vercel config", "✅ Already present"), skip.
2. Ask: **Add Vercel deployment config** (`apps/docs/vercel.json`) | **Skip**
3. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs-vercel --root <cwd> --orchestrator <build.orchestrator>
   ```
   `build.orchestrator: turbo` → config with `turbo-ignore @repo/docs`. Other → simple `cd apps/docs && bun run build`.
   D✅("Fumadocs Vercel config — apps/docs/vercel.json").
4. Remind: connect `apps/docs/` as Vercel project (root dir = `apps/docs`), set `NEXT_PUBLIC_APP_URL`.

## Phase 2 — Pre-commit Hooks (Optional)

### 2a — Detect existing hooks

Check in parallel:
```bash
test -f lefthook.yml && echo found || echo missing
test -d .husky && echo found || echo missing
test -f .pre-commit-config.yaml && echo found || echo missing
test -f .git/hooks/pre-commit && echo found || echo missing
```

∃ any ∧ ¬F → D("Pre-commit hooks", "✅ Already configured"), skip.
∃ any ∧ F → AskUserQuestion: **Overwrite** (regenerate from stack.yml) | **Skip** (keep existing). Skip → D⏭("Pre-commit hooks"), stop Phase 2.

### 2b — Resolve tool

Read `hooks.tool` from σ.

- `none` → D⏭("Pre-commit hooks — Disabled in stack.yml"), skip.
- `auto` ∨ absent → infer: `python` → **pre-commit**, else → **lefthook**.
- explicit (`lefthook`|`pre-commit`|`husky`) → use directly.

### 2c — Offer setup

Ask: **Set up `<tool>`** (catches lint/format before push) | **Skip**.

### 2d — Install

Let: lintCmd := stackVal(`commands.lint`) (default `bun run lint`), tchkCmd := stackVal(`commands.typecheck`) (default `bun run typecheck`).

**lefthook:**
a. Detect license cmd: Python → `uv run tools/license_check.py` | JS → `bun tools/licenseChecker.ts`.
b. Install lefthook (branch on `{package_manager}`):
   - `bun`: `bun add -d lefthook`
   - `pnpm`: `pnpm add -D lefthook`
   - `npm`: `npm install --save-dev lefthook`
   - `yarn`: `yarn add --dev lefthook`
   - `python` runtime: Lefthook is a Go binary — check `which lefthook`; missing → display `brew install lefthook` / `go install github.com/evilmartians/lefthook@latest` and continue without installing
c. Write `lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>

     trufflehog:
       run: trufflehog git file://. --only-verified --fail

   pre-push:
     commands:
       license:
         run: <license-cmd>
   ```
d. `bunx lefthook install`
e. Copy license tools (JS/bun only — after lefthook install):
   ```bash
   [[ "${CLAUDE_PLUGIN_ROOT}" =~ ^/[a-zA-Z0-9/_.-]+$ ]] || { echo "ERROR: invalid CLAUDE_PLUGIN_ROOT"; exit 1; }
   Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")")
   test -f "${Φ}/tools/licenseChecker.ts" || { echo "ERROR: licenseChecker.ts not found in plugin (path: ${Φ}/tools/)"; exit 1; }
   mkdir -p tools
   cp "${Φ}/tools/licenseChecker.ts" tools/licenseChecker.ts
   # Copy default policy template only if no policy file exists yet
   test -f .license-policy.json || cp "${Φ}/tools/license-policy.json.example" .license-policy.json
   # Gitignore the reports/ output directory
   grep -q 'reports/' .gitignore 2>/dev/null || echo 'reports/' >> .gitignore
   ```
   Add `"license": "bun tools/licenseChecker.ts"` to `package.json` scripts (if not set).
   D✅("License checker — tools/licenseChecker.ts copied").

**pre-commit (Python):**
a. Install: `uv add --dev pre-commit pip-licenses`
b. Copy: `mkdir -p tools && cp "${CLAUDE_PLUGIN_ROOT}/tools/license_check.py" tools/license_check.py`
c. Write `.pre-commit-config.yaml`:
   ```yaml
   repos:
     - repo: local
       hooks:
         - id: lint
           name: lint
           entry: <commands.lint>
           language: system
           pass_filenames: false
         - id: typecheck
           name: typecheck
           entry: <commands.typecheck>
           language: system
           pass_filenames: false
         - id: trufflehog
           name: trufflehog secret scan
           entry: trufflehog git file://. --only-verified --fail
           language: system
           pass_filenames: false
         - id: license
           name: license check
           entry: uv run tools/license_check.py
           language: system
           pass_filenames: false
           stages: [pre-push]
   ```
d. `uv run pre-commit install && uv run pre-commit install --hook-type pre-push`

**Common post-install ∀ tool:**

f. Check trufflehog binary:
   ```bash
   which trufflehog 2>/dev/null && echo "installed" || echo "missing"
   ```
   missing → display:
   ```
   ⚠️  trufflehog binary not found — pre-commit hook will fail until installed.
       Install options:
         • Homebrew:       brew install trufflehog
         • GitHub release: https://github.com/trufflesecurity/trufflehog/releases
   ```

g. Run license check + offer policy generation:
   - JS: `bun tools/licenseChecker.ts --json 2>/dev/null`
   - Python: `uv run tools/license_check.py --json 2>/dev/null`
   - exit 0 → D("License check", "✅ All packages compliant").
   - exit 1 → parse violations, display list, Ask: **Generate .license-policy.json** | **Skip**.
     - yes → write `.license-policy.json` with violating names in `allowlist`. D("License policy", "✅ .license-policy.json created (N packages) — review before production").
     - skip → D("License policy", "⏭ Skipped — first push will fail").
   - exit 2 (Python, pip-licenses missing) → D("License check", "⏭ pip-licenses not installed — run `uv add --dev pip-licenses`").

h. D("Pre-commit hooks", "✅ {tool} installed (lint + typecheck + trufflehog on commit, license on push)").

## Phase 3 — Marketplace Plugins

dev-core already installed. Discover available plugins from our marketplace and curated external sources.

### 3a — Discover Roxabi plugins

1. Ensure marketplace is registered:
   ```bash
   claude plugin marketplace add Roxabi/roxabi-plugins 2>/dev/null || true
   ```

2. Fetch live plugin list from GitHub:
   ```bash
   gh api repos/Roxabi/roxabi-plugins/contents/.claude-plugin/marketplace.json \
     -H "Accept: application/vnd.github.raw+json" \
     | jq -r '.plugins[] | [.name, .description, (.category // "other")] | @tsv'
   ```
   API failure → fall back to **Static fallback list** below.

3. Check already-installed plugins:
   ```bash
   claude plugin list --json 2>/dev/null | jq -r '.[].name' || claude plugin list 2>/dev/null
   ```

4. Filter: remove `dev-core` + any already-installed plugin from the discovered list.

5. Group remaining plugins by `category` (from the tsv above). ∀ group:
   - Print: `### <Category>` + `| Plugin | Description |` table
   - Ask: **Install all** | **Pick** | **Skip**
   - Pick → Ask per plugin: **Install** | **Skip**
   - Install: `claude plugin install <name>`

### 3b — Curated external marketplaces

Offer plugins from vetted external repos. Each entry below is a `<owner/repo>` marketplace source.

| Source | Highlights |
|--------|-----------|
| `anthropics/claude-code-plugins` | Official Anthropic plugin collection |

∀ source:
1. Fetch its `marketplace.json` (same API call pattern as 3a).
2. Present plugins not already installed, grouped by category.
3. Ask: **Install all** | **Pick** | **Skip**
4. Install: `claude plugin marketplace add <owner/repo> 2>/dev/null || true && claude plugin install <name>`

### 3c — Static fallback (GitHub API unavailable)

Use this list if `gh api` fails in 3a:

| Plugin | Category | What it does |
|--------|----------|-------------|
| `compress` | dev-tools | Rewrite agent/skill definitions in compact math/logic notation |
| `1b1` | dev-tools | Walk a list one by one: brief → decide → act → next |
| `web-intel` | dev-tools | Scrape Twitter/X, GitHub, YouTube, Reddit — summarize, analyze |
| `react-best-practices` | frontend | 58 React/Next.js perf rules across 8 categories |
| `composition-patterns` | frontend | Avoid boolean prop proliferation — compound components |
| `web-design-guidelines` | frontend | Review UI for accessibility, UX, and Web Interface Guidelines |
| `visual-explainer` | visual | Self-contained HTML pages with diagrams and data tables |
| `frontend-slides` | visual | Zero-dependency HTML presentations — 12 presets, PPT conversion |
| `image-prompt-generator` | visual | AI image prompts with visual identity and style consistency |
| `cv` | career | Generate and adapt CVs from structured JSON |
| `linkedin-apply` | career | Score LinkedIn jobs against your profile — APPLY / REVIEW / SKIP |
| `linkedin-post-generator` | career | Engaging LinkedIn posts with best practices |
| `vault` | data | Unified local SQLite+FTS5 vault — CRUD and full-text search |
| `get-invoice-details` | data | Extract structured data from invoice documents → JSON |

After all groups: D("Marketplace plugins", "installed: name, name, ... (or: ⏭ None installed)").

## Phase 4 — Report

```
CI Setup Complete
=================

  CI/CD workflows   ✅ Created / ✅ Already configured / ⏭ Skipped
  TruffleHog        ✅ Secret scanning configured / ⏭ Skipped
  Dependabot        ✅ .github/dependabot.yml created / ⏭ Skipped
  Fumadocs Vercel   ✅ Created / ⏭ Skipped / ⏭ Not configured
  Pre-commit hooks  ✅ lefthook installed / ✅ pre-commit installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped
  License checker   ✅ tools/licenseChecker.ts copied (JS) / ✅ tools/license_check.py copied (Python) / ⏭ Skipped
  License policy    ✅ .license-policy.json created (N packages) / ✅ All compliant / ⏭ Skipped / ⏭ pip-licenses missing
  Marketplace       ✅ N plugins installed (name, name, ...) / ⏭ Skipped
```

## Safety Rules

1. **Never push to remote** without user confirmation
2. **Always AskUserQuestion** before installing hooks or plugins
3. **Idempotent** — skip already-configured items unless F

$ARGUMENTS
