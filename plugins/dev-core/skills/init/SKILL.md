---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — auto-detect GitHub Project V2, set up dashboard launcher, env vars, artifacts. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.6.0
allowed-tools: Bash, ToolSearch, AskUserQuestion
---

# Init

Let:
  I_TS  := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  D_TS  := `${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
  F     := `--force` flag present in `$ARGUMENTS`
  PID   := selected project ID (PVT_...)
  disc  := JSON result of `bun $I_TS discover`
  Φ     := CLAUDE_PLUGIN_ROOT
  ω     := owner/repo (from disc)
  σ     := `.claude/stack.yml`
  δ     := `.claude/dev-core.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")
  Ask(opts)        := AskUserQuestion with given options
  stackVal(key)    := value read from σ
  ensureGitignore(entry) := `grep -q '{entry}' .gitignore 2>/dev/null || echo '{entry}' >> .gitignore`

Configure current project for dev-core. Auto-detect GitHub repo, Project V2 board, field IDs, optional Vercel. Write δ (primary config), `.env`/`.env.example` (legacy fallback), `.claude/run-dashboard.ts`, create `artifacts/`.

Config resolution (3-tier fallback): δ → env var → `gh` CLI (github_repo only). Safe to re-run — merges with existing unless F. All data lives in TypeScript; this SKILL.md orchestrates via CLI subcommands.

## Phase 1 — Parse Input + Idempotency

¬F → check existing: `test -f .claude/dev-core.yml && echo "1" || grep -c 'dev-core' .env 2>/dev/null || echo "0"`.
result > 0 → Ask: **Re-configure** (≡F) | **Skip** (abort).

## Phase 2 — Prerequisites

Run: `bun $I_TS prereqs`. Parse JSON → display ✅/❌ table for bun, gh, git remote.

∃ ❌ → show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

Ask: **Abort** | **Continue anyway** (warn: some features won't work).

## Phase 2b — Stack Configuration

Set up σ early — later phases read runtime, package manager, commands, deploy platform, hooks tool, docs format.

1. `test -f .claude/stack.yml && echo exists || echo missing`

2. **missing** → Ask: **Set up stack.yml now** (recommended) | **Skip** (fallback defaults).

3. **Set up** → O_stackSetup:
   - `cp "${Φ}/stack.yml.example" .claude/stack.yml`
   - Ask ∀ critical field:
     - **Runtime** → **bun** | **node** | **python** → `runtime` + `package_manager`
     - **Backend path** (e.g., `apps/api`, blank=none) → `backend.path`
     - **Frontend path** (e.g., `apps/web`, blank=none) → `frontend.path`
     - **Test command** (e.g., `bun run test`) → `commands.test`
   - Write values into σ.
   - Inform: "Fill in remaining fields in σ before running agents."

4. Add @import: `head -1 CLAUDE.md` → ¬`@.claude/stack.yml` → prepend `@.claude/stack.yml\n`. D✅("@import").

5. ensureGitignore(`.claude/stack.yml`). D✅(".gitignore").

6. ¬`.claude/stack.yml.example` → `cp "${Φ}/stack.yml.example" .claude/stack.yml.example`. D("stack.yml.example", "✅ Created (commit this file)").

7. **existing** → D("stack.yml", "✅ Already exists"), skip.

## Phase 2c — Scaffold CLAUDE.md Critical Rules

Generate governance rules (dev process, AskUserQuestion, git conventions, etc.) from σ values. Sections vary by detected project type.

σ ∄ → D("Critical Rules", "⏭ Skipped — requires stack.yml"), skip to Phase 3.

1. Run: `bun $I_TS scaffold-rules --stack-path .claude/stack.yml --claude-md CLAUDE.md`
2. Parse JSON → extract `projectType`, `sections`, `markdown`, `existing`.

3. Display detected type:
   ```
   Project type: {projectType}
   Sections to scaffold: {sections.length} ({section ids joined by ", "})
   ```

4. Check `existing.sectionIds`:
   - **∅ existing** (no Critical Rules yet) → Ask: **Scaffold Critical Rules** (append to CLAUDE.md) | **Skip**
   - **partial** (some sections present, some missing) → list missing, Ask: **Merge** (append only missing sections) | **Replace** (rewrite all Critical Rules) | **Skip**
   - **all present** → D("Critical Rules", "✅ Already complete"), skip.

5. **Scaffold / Replace** → append or replace the `## Critical Rules` block in CLAUDE.md with `markdown` from result. Preserve any content before `## Critical Rules` and after the last generated section.

6. **Merge** → ∀ section ∈ generated ∧ section.id ∉ existing.sectionIds → append section markdown after the last existing Critical Rules heading in CLAUDE.md.

7. D("Critical Rules", "✅ Scaffolded ({sections.length} sections for {projectType})")

## Phase 3 — Auto-Discover Configuration

Run: `bun $I_TS discover`. Parse → extract `owner`, `repo`, `projects`, `fields`, `labels`, `workflows`, `protection`, `vercel`, `env`.

### 3a. Project Board

- |projects| == 0 → Ask: **Create project board** | **Skip**. Create → Ask: **Technical** (Size/Priority, CI/Vercel) | **Company** (Quarter/Pillar, no CI/Vercel). Run `bun $I_TS create-project --owner <owner> --repo <repo> [--type technical|company]`. Parse PID + field IDs.
- |projects| == 1 → auto-select from disc.
- |projects| > 1 → numbered list, Ask to pick.

¬PID → field IDs stay empty. PID ∃ ∧ fields missing → run `create-project`.

After selection: re-run `bun $I_TS discover` to refresh field IDs. Status/Size/Priority still missing → run `bun $I_TS create-project --owner <owner> --repo <repo> [--type technical|company]` (handles pre-existing Status gracefully).

#### create-project options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--type` | `technical` \| `company` | `technical` | Sets project type in workspace.json. |

- **technical**: col2=Size, col3=Priority. CI/Vercel/dev links. Sort by priority.
- **company**: col2=Quarter, col3=Pillar. No CI/Vercel/dev links. Sort by quarter asc.

### 3a-bis. Project Workflows

PID ∃ → run: `bun $I_TS list-workflows --project-id <PVT_...>`. Parse JSON, display table:

```
  GitHub Project Workflows
  ┌─────────────────────────────────────────┬──────────┐
  │ Workflow                                │ Status   │
  ├─────────────────────────────────────────┼──────────┤
  │ Auto-add to project                     │ ❌ off   │
  │ Auto-add sub-issues to project          │ ❌ off   │
  │ Auto-archive items                      │ ❌ off   │
  │ ...                                     │          │
  └─────────────────────────────────────────┴──────────┘
```

∃ disabled → display:
```
  ℹ️  GitHub doesn't expose an API to toggle built-in project workflows.
      Enable them manually in the project settings:
      https://github.com/orgs/<owner>/projects/<number>/workflows
      (replace `orgs` with `users` for personal accounts)
```

### 3b–3f. Remaining Discovery

Pattern: ∀ feature ∈ {labels, workflows, TruffleHog, Dependabot, branch-protection, Vercel, issue-migration}:
  disc shows missing/available → Ask: **Set up** | **Skip** → run subcommand → D(feature, result) | D⏭(feature).

#### 3b. Labels
`labels.missing` ≠ ∅ → Ask: **Create all** | **Type only** | **Area only** | **Skip**.
Run: `bun $I_TS labels --repo <owner/repo> --scope <all|type|area>`

#### 3c. Workflows
`workflows.missing` ≠ ∅ → Ask: **Set up CI/CD** | **Skip**.
yes → Ask each: Stack (**Bun**|**Node**|**Python (uv)**), Test (**Vitest**|**Jest**|**Pytest**|**None**), Deploy (**Vercel**|**None**).
Note: Python generates `ci.yml` running `uv run ruff check .` + `uv run pytest`.

Run: `bun $I_TS workflows --owner <owner> --repo <repo> --stack bun --test vitest --deploy vercel`

Pushes workflow files directly to remote via GitHub REST API — no local commit. Files created/updated idempotently.

Generic-only (no ci.yml): `bun $I_TS push-workflows --owner <owner> --repo <repo>`

After pushing, set PAT secret (automatic):
```bash
gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"
```

D("PAT secret", "✅ Set").

#### 3c-bis. TruffleHog
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

#### 3c-ter. Dependabot
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

#### 3d. Branch Protection + Ruleset
Ask: **Set up branch protection** | **Skip**.
yes → `bun $I_TS protect-branches --repo <owner/repo>`

This command: applies branch protection (required `ci` check, strict up-to-date) on main + staging; creates `PR_Main` ruleset if missing (squash/rebase/merge allowed, no deletion/force push, thread resolution required — merge commits needed for promotion PRs staging→main).

Parse result. Display per-branch ✅/❌ + Ruleset status (Created | Already exists | Failed).

#### 3e. Vercel (Optional)
`vercel` ≠ null in disc → Ask: **Set up Vercel** | **Skip**.
yes → Ask for `VERCEL_TOKEN` (free text — Vercel Settings → Tokens).

#### 3f. Issue Migration
`issues.orphaned > 0` in disc → Ask: **Add N open issues to board** | **Skip**.
yes → `bun $I_TS migrate-issues --owner <owner> --repo <repo> --project-number <N>`. Parse → D("Issues", "Added {added}/{total} to board").

## Phase 4 — Confirm Values

Display summary table:

```
dev-core Configuration
======================

  GitHub:
    GITHUB_REPO         = owner/repo
    GH_PROJECT_ID       = PVT_kwHO...
    STATUS_FIELD_ID     = PVTSSF_...
    SIZE_FIELD_ID       = PVTSSF_...
    PRIORITY_FIELD_ID   = PVTSSF_...

  Labels:               11 labels (created / skipped)
  Branch protection:    main, staging (created / skipped)
```

Ask: **Confirm** | **Edit a value** | **Abort**.
Edit → ask which, accept new, re-display, re-confirm.

## Phase 5 — Scaffold

### 5a. Write δ (primary config)

```yaml
# dev-core plugin configuration
# 3-tier fallback: this file → process.env → gh CLI (github_repo only)
github_repo: <owner/repo>
gh_project_id: <PVT_...>
status_field_id: <PVTSSF_...>
size_field_id: <PVTSSF_...>
priority_field_id: <PVTSSF_...>
status_options_json: '<json>'
size_options_json: '<json>'
priority_options_json: '<json>'
```

Ensure δ ∈ `.gitignore`.

### 5b. Scaffold (legacy .env + shim + artifacts)

Run: `bun $I_TS scaffold --github-repo <owner/repo> --project-id <PVT_...> --status-field-id <PVTSSF_...> --size-field-id <PVTSSF_...> --priority-field-id <PVTSSF_...> --status-options-json '<json>' --size-options-json '<json>' --priority-options-json '<json>' [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]`

Also writes `.env`/`.env.example` for backward compat. δ takes precedence at runtime via `loadDevCoreConfig()`.

Installs `roxabi` shim at `~/.local/bin/roxabi` (or `~/bin/roxabi`) — self-healing shell script resolving latest active dev-core plugin cache at runtime. Run `roxabi dashboard` to launch. Shim survives plugin updates.

## Phase 6 — Workspace Registration

Register current project in shared workspace config (enables multi-project dashboard).

1. Check:
   ```bash
   bun -e "
   import { readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/adapters/workspace-helpers.ts'
   const ws = readWorkspace()
   console.log(ws.projects.some(p => p.repo === process.env.GITHUB_REPO) ? 'registered' : 'not-registered')
   "
   ```

2. registered → D("workspace.json", "✅ Already registered"), skip.

3. ¬registered → Ask: **Add to workspace** | **Skip**

4. Add:
   ```bash
   bun -e "
   import { getWorkspacePath, readWorkspace, writeWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/adapters/workspace-helpers.ts'
   const ws = readWorkspace()
   const entry = {
     repo: process.env.GITHUB_REPO ?? '',
     projectId: process.env.GH_PROJECT_ID ?? '',
     label: (process.env.GITHUB_REPO ?? '').split('/')[1] ?? '',
   }
   if (process.env.VERCEL_PROJECT_ID) entry.vercelProjectId = process.env.VERCEL_PROJECT_ID
   if (process.env.VERCEL_TEAM_ID) entry.vercelTeamId = process.env.VERCEL_TEAM_ID
   ws.projects.push(entry)
   writeWorkspace(ws)
   console.log('written:' + getWorkspacePath())
   "
   ```
   D("workspace.json", "✅ Registered <GITHUB_REPO> at <path>").

5. Skip → D⏭("workspace.json").

## Phase 6b — Bulk Discovery

Scan filesystem for repos with dev-core configured but ∉ workspace.json.

1. Find candidates:
   ```bash
   find "$HOME" -maxdepth 6 \( -path "*/.claude/dev-core.yml" -o -name ".env" \) 2>/dev/null \
     | sort -u
   ```

2. ∀ found: extract config:
   ```bash
   grep -E "^(github_repo|gh_project_id):" <path>/.claude/dev-core.yml 2>/dev/null
   grep -E "^(GITHUB_REPO|GH_PROJECT_ID|VERCEL_PROJECT_ID|VERCEL_TEAM_ID)=" <path>/.env 2>/dev/null
   ```

3. Filter: current project + already-registered.

4. ∄ candidates → skip silently.

5. ∃ candidates → display list, Ask: **Add all** | **Select** | **Skip**.

6. Add → ∀ chosen: read config, derive label from repo name, append to workspace.json (include Vercel IDs only if ∃).
   D("workspace.json", "✅ Added N projects (repo-a, repo-b, ...)").

7. Skip → D⏭("Bulk discovery").

## Phase 7 — Documentation Scaffolding (Optional)

1. Read `docs.path` + `docs.format` from σ (defaults: `docs`, `md`).
2. `{docs.path}/standards/` ∃ → D("Docs scaffolding", "✅ Already present"), skip.
3. Ask: **Scaffold standard docs** (architecture/, standards/, guides/ with templates) | **Skip**.
4. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-docs --format <docs.format> --path <docs.path>
   ```
5. D("Docs scaffolding", "✅ Created {filesCreated.length} files in {docsPath}/").

### Phase 7b — Fumadocs App Scaffold (Optional)

Run only if `docs.framework: fumadocs` in σ.

1. Ask: **Scaffold Fumadocs app** (`apps/docs/` Next.js + `docs/` content — Mermaid, Shiki, Tailwind v4) | **Skip**
2. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs --root <cwd> --docs-path <docs.path>
   ```
   D("Fumadocs scaffold", "✅ Created {filesCreated.length} files in apps/docs/ and {docs.path}/"). List files grouped by dir. ∃ warnings → display each with ⚠️.
3. Remind: `bun install` in `apps/docs/`, then `bun dev` for docs server on port 3002.

## Phase 8 — VS Code MDX Preview (Optional)

Run only if `find . -name "*.mdx" -not -path "*/node_modules/*" | head -1` returns result ∨ `docs.format: mdx` in σ.

1. Check `.vscode/settings.json` for `"*.mdx": "markdown"` in `files.associations`.
2. ∃ → D("VS Code MDX preview", "✅ Already configured"), skip.
3. ∄ → Ask: **Add VS Code MDX preview** | **Skip**.
4. yes → ¬file → create `{"files.associations": {"*.mdx": "markdown"}}` | ∃file → merge key. D✅("VS Code MDX preview").

## Phase 9 — CI Setup

Set up GitHub Actions via REST API (no local git). Runs last so σ values available.

Standard set: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

1. Check existing via REST:
   ```bash
   gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
   ```
   All present → D("CI/CD workflows", "✅ Already configured"), skip.

2. Auto-detect from σ: `stack` ← `runtime`, `test` ← `commands.test` (vitest→Vitest, jest→Jest, pytest→Pytest, else→None), `deploy` ← `deploy.platform`.

3. ∃ missing → Ask: **Set up CI/CD** | **Skip**.

4. yes:
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

5. skip → D⏭("CI/CD workflows").

### Phase 9b — Fumadocs Vercel Deployment (Optional)

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

## Phase 10 — Pre-commit Hooks (Optional)

### 10a — Detect existing hooks

Check in parallel:
```bash
test -f lefthook.yml && echo found || echo missing
test -d .husky && echo found || echo missing
test -f .pre-commit-config.yaml && echo found || echo missing
test -f .git/hooks/pre-commit && echo found || echo missing
```

∃ any → D("Pre-commit hooks", "✅ Already configured"), skip.

### 10b — Resolve tool

Read `hooks.tool` from σ.

- `none` → D⏭("Pre-commit hooks — Disabled in stack.yml"), skip.
- `auto` ∨ absent → infer: `python` → **pre-commit**, else → **lefthook**.
- explicit (`lefthook`|`pre-commit`|`husky`) → use directly.

### 10c — Offer setup

Ask: **Set up `<tool>`** (catches lint/format before push) | **Skip**.

### 10d — Install

Let: lintCmd := stackVal(`commands.lint`) (default `bun run lint`), tchkCmd := stackVal(`commands.typecheck`) (default `bun run typecheck`).

O_hookInstall(tool) determines flow:

**lefthook:**
a. Detect license cmd: Python → `uv run tools/license_check.py` | JS → `bun tools/licenseChecker.ts`.
b. `bun add -d lefthook`
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

## Phase 10b — Marketplace Plugins

Offer additional Roxabi plugins grouped by theme. dev-core already installed.

∀ group below: display name + table, Ask: **Install all** | **Pick** | **Skip**. Pick → Ask per plugin: **Install** | **Skip**. Install: `claude plugin install <name>`.

### Group 1 — Dev tools

| Plugin | What it does |
|--------|-------------|
| `compress` | Rewrite agent/skill definitions in compact math/logic notation — cuts token usage |
| `1b1` | Walk a list one by one: brief → decide → act → next. Great for review queues |
| `web-intel` | Scrape Twitter/X, GitHub, YouTube, Reddit, webpages — summarize, analyze, benchmark |

### Group 2 — Frontend quality

| Plugin | What it does |
|--------|-------------|
| `react-best-practices` | 58 React/Next.js perf rules across 8 categories, prioritized by impact |
| `composition-patterns` | Avoid boolean prop proliferation — compound components, context providers |
| `web-design-guidelines` | Review UI for accessibility, UX, and Web Interface Guidelines compliance |

### Group 3 — Visual output

| Plugin | What it does |
|--------|-------------|
| `visual-explainer` | Self-contained HTML pages with diagrams, visualizations, and data tables |
| `frontend-slides` | Zero-dependency HTML presentations — 12 presets, PPT conversion |
| `image-prompt-generator` | AI image prompts with visual identity and style consistency |

### Group 4 — Career & content

| Plugin | What it does |
|--------|-------------|
| `cv` | Generate and adapt CVs from structured JSON, tailored for specific job postings |
| `linkedin-apply` | Scrape LinkedIn jobs and score against your profile — APPLY / REVIEW / SKIP |
| `linkedin-post-generator` | Engaging LinkedIn posts with best practices and visual identity |

### Group 5 — Data & productivity

| Plugin | What it does |
|--------|-------------|
| `vault` | Unified local SQLite+FTS5 vault — CRUD and full-text search across Roxabi data |
| `get-invoice-details` | Extract structured data from invoice documents (text or PDF) → JSON |
| `voice-cli` | Author TTS scripts, generate speech, clone voices, transcribe audio |

After all groups: D("Marketplace plugins", "installed: name, name, ... (or: ⏭ None installed)").

## Phase 10c — LSP Support (Optional)

Enable `ENABLE_LSP_TOOL` for richer code intelligence in Claude Code sessions.

1. Read `lsp.enabled` from σ. `false` → D⏭("LSP — Disabled in stack.yml"), skip. `true` ∨ absent → continue.

2. Check: `grep -q '^ENABLE_LSP_TOOL=' .env 2>/dev/null && echo "set" || echo "missing"`. set → D("ENABLE_LSP_TOOL", "✅ Already configured"), skip to step 6.

3. Ask: **Enable LSP** (`ENABLE_LSP_TOOL=1` + language server) | **Skip**.

4. yes:
   a. Add to `.env` and `.env.example`:
      ```bash
      echo 'ENABLE_LSP_TOOL=1' >> .env
      grep -q '^ENABLE_LSP_TOOL=' .env.example 2>/dev/null || echo 'ENABLE_LSP_TOOL=1' >> .env.example
      ```
   b. Detect LSP server from `lsp.server` or `runtime`:

      | runtime | server | install | binary |
      |---------|--------|---------|--------|
      | `bun`/`node`/`deno` | typescript-language-server | `{package_manager} add -d typescript-language-server typescript` | `typescript-language-server` |
      | `python` | pyright | `uv tool install pyright` or `pip install pyright` | `pyright` |
      | `rust` | rust-analyzer | `rustup component add rust-analyzer` | `rust-analyzer` |
      | `go` | gopls | `go install golang.org/x/tools/gopls@latest` | `gopls` |

   c. Check: `which <binary> 2>/dev/null`. missing → run install → re-check. still-missing → ⚠️ "not in PATH — restart shell".
   d. D("LSP", "✅ ENABLE_LSP_TOOL=1 set, <server> installed").

5. Skip → D⏭("LSP").
6. Already set ∧ binary ∃ → D("LSP", "✅ Already configured (<binary>)").

## Phase 11 — Report

Display final summary:

```
dev-core initialized
====================

  dev-core.yml      ✅ Written (.claude/dev-core.yml)
  .env              ✅ Written (N variables, legacy fallback)
  .env.example      ✅ Written
  Project board     ✅ Created / Detected / ⏭ Skipped
  Issue migration   ✅ N issues added to board / ⏭ Skipped
  Labels            ✅ N labels created / ⏭ Skipped
  Project workflows ✅ Displayed / ⏭ Skipped
  Branch protection ✅ Created / ⏭ Skipped
  Ruleset PR_Main   ✅ Created / ✅ Already exists / ⏭ Skipped
  roxabi shim       ✅ Installed (~/.local/bin/roxabi)
  PATH              ✅ ~/.local/bin added to .bashrc/.zshrc  (or ⏭ already present)
  artifacts/        ✅ Created
  .gitignore        ✅ .env added
  workspace.json    ✅ Registered <repo> / ⏭ Skipped
  bulk discovery    ✅ Added N projects / ⏭ Skipped / ⏭ No others found
  stack.yml         ✅ Configured / ✅ Already exists / ⏭ Skipped
  Marketplace       ✅ N plugins installed (name, name, ...) / ⏭ Skipped
  VS Code MDX preview   ✅ Added / ✅ Already configured / ⏭ Skipped / ⏭ No .mdx files found
  CI/CD workflows   ✅ Created / ✅ Already configured / ⏭ Skipped
  TruffleHog        ✅ Secret scanning configured / ⏭ Skipped
  Dependabot        ✅ .github/dependabot.yml created / ⏭ Skipped
  Pre-commit hooks      ✅ lefthook installed / ✅ pre-commit installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped
  License checker   ✅ tools/licenseChecker.ts copied (JS) / ✅ tools/license_check.py copied (Python) / ⏭ Skipped
  License policy    ✅ .license-policy.json created (N packages) / ✅ All compliant / ⏭ Skipped / ⏭ pip-licenses missing
  LSP               ✅ ENABLE_LSP_TOOL=1 set, <server> installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped

Next steps:
  /doctor                Verify full configuration health
  roxabi dashboard       Launch the issues dashboard  (restart shell or: source ~/.bashrc)
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

## Safety Rules

1. **Never overwrite `.claude/dev-core.yml` or `.env` values** without F or explicit user confirmation
2. **Always AskUserQuestion** before destructive or write operations
3. **Never commit `.claude/dev-core.yml` or `.env`** — ensure both are in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites
6. **Never commit `.claude/stack.yml`** — only `.claude/stack.yml.example`

$ARGUMENTS
