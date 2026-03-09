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

Configure current project for dev-core. Auto-detects GitHub repo, Project V2 board, field IDs, optional Vercel. Writes `.env`, `.env.example`, `.claude/run-dashboard.ts`, creates `artifacts/`.

Safe to re-run — merges with existing config unless F.

All data (label definitions, workflow templates, protection payloads) lives in TypeScript. This SKILL.md orchestrates by running CLI subcommands and presenting results.

## Phase 1 — Parse Input + Idempotency

¬F → check existing config: `grep -c 'dev-core' .env 2>/dev/null || echo "0"`.
result > 0 → AskUserQuestion: **Re-configure** (same as F) | **Skip** (abort).

## Phase 2 — Prerequisites

Run: `bun $I_TS prereqs`. Parse JSON → display ✅/❌ table for bun, gh, git remote.

any ❌ → show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

AskUserQuestion: **Abort** | **Continue anyway** (warn: some features won't work).

## Phase 2b — Stack Configuration

Set up `.claude/stack.yml` early so all later phases can read stack values (runtime, package manager, commands, deploy platform, hooks tool, docs format).

1. `test -f .claude/stack.yml && echo exists || echo missing`

2. **missing** → AskUserQuestion: **Set up stack.yml now** (recommended — later phases use it for CI, hooks, Dependabot) | **Skip** (later phases will use fallback defaults).

3. **Set up**:
   - `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml`
   - AskUserQuestion ∀ critical field:
     - **Runtime** → **bun** | **node** | **python** → `runtime` + `package_manager`
     - **Backend path** (e.g., `apps/api`, or leave blank if none) → `backend.path`
     - **Frontend path** (e.g., `apps/web`, or leave blank if none) → `frontend.path`
     - **Test command** (e.g., `bun run test`) → `commands.test`
   - Write confirmed values into `.claude/stack.yml`.
   - Inform: "Fill in the remaining fields in `.claude/stack.yml` before running agents."

4. Add @import to CLAUDE.md:
   - `head -1 CLAUDE.md` → ¬`@.claude/stack.yml` → prepend `@.claude/stack.yml\n`.
   - Display: "Added `@.claude/stack.yml` import to CLAUDE.md ✅"

5. Add stack.yml to .gitignore:
   - `grep -q '\.claude/stack\.yml' .gitignore 2>/dev/null && echo found || echo missing`
   - missing → append `.claude/stack.yml` to `.gitignore`.
   - Display: "Added `.claude/stack.yml` to .gitignore ✅"

6. Copy stack.yml.example (committed reference):
   - ¬`.claude/stack.yml.example` → `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml.example`
   - Display: ".claude/stack.yml.example created ✅ (commit this file)"

7. **existing** → display `stack.yml ✅ Already exists`, skip setup.

## Phase 3 — Auto-Discover Configuration

Run: `bun $I_TS discover`. Parse → extract `owner`, `repo`, `projects`, `fields`, `labels`, `workflows`, `protection`, `vercel`, `env`.

### 3a. Project Board

- |projects| == 0 → AskUserQuestion: **Create project board** | **Skip**. Create → `bun $I_TS create-project --owner <owner> --repo <repo>`, parse PID + field IDs.
- |projects| == 1 → auto-select, use its ID from disc.
- |projects| > 1 → present numbered list, AskUserQuestion to pick one.

- If **0 projects**: AskUserQuestion: **Create project board** | **Skip**. If Create: AskUserQuestion: **Technical** (Size/Priority fields, CI/Vercel integration) | **Company** (Quarter/Pillar fields, no CI/Vercel). Run `bun $INIT_TS create-project --owner <owner> --repo <repo> [--type technical|company]`. Parse result for project ID and field IDs.
- If **1 project**: auto-select, use its ID from discover result.
- If **multiple projects**: present numbered list, AskUserQuestion to pick one.

¬PID → field IDs stay empty. PID ∃ ∧ fields missing from disc → run `create-project` to create them.

After selection: re-run `bun $I_TS discover` to refresh field IDs. Status/Size/Priority still missing → run `bun $I_TS create-project --owner <owner> --repo <repo>` (handles pre-existing Status field gracefully).

After project selection, re-run `bun $INIT_TS discover` to refresh field IDs for the selected project. If Status/Size/Priority fields are still missing after re-discovery, run `bun $INIT_TS create-project --owner <owner> --repo <repo> [--type technical|company]` to create them (handles pre-existing Status field gracefully).

#### create-project options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--type` | `technical` \| `company` | `technical` | Sets project type in workspace.json. |

- **technical**: col2=Size, col3=Priority. CI/Vercel/dev links shown. Sort by priority.
- **company**: col2=Quarter, col3=Pillar. No CI/Vercel/dev links. Sort by quarter ascending.

### 3a-bis. Project Workflows

PID ∃ → run: `bun $I_TS list-workflows --project-id <PVT_...>`. Parse JSON array, display table:

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

∃ disabled workflows → display:
```
  ℹ️  GitHub doesn't expose an API to toggle built-in project workflows.
      Enable them manually in the project settings:
      https://github.com/orgs/<owner>/projects/<number>/workflows
      (replace `orgs` with `users` for personal accounts)
```

### 3b. Labels

`labels.missing` ≠ ∅ → AskUserQuestion: **Create all labels** | **Type labels only** | **Area labels only** | **Skip labels**.
Run: `bun $I_TS labels --repo <owner/repo> --scope <all|type|area>`

### 3c. Workflows

`workflows.missing` ≠ ∅ → AskUserQuestion: **Set up CI/CD workflows** | **Skip**.

yes → AskUserQuestion (each):
1. Stack: **Bun** | **Node** | **Python (uv)**
2. Test framework: **Vitest** | **Jest** | **Pytest** | **None**
3. Deploy: **Vercel** | **None**

Note: Python workflow generates `ci.yml` running `uv run ruff check .` and `uv run pytest`.

Run: `bun $INIT_TS workflows --owner <owner> --repo <repo> --stack bun --test vitest --deploy vercel`

This pushes all workflow files directly to the remote repo via GitHub REST API — no local git commit needed. Files are created or updated idempotently.

To add only the generic workflows (`auto-merge.yml` + `pr-title.yml`) without touching `ci.yml`:

```bash
bun $INIT_TS push-workflows --owner <owner> --repo <repo>
```

After pushing workflows, automatically set the `PAT` secret using the current gh token (no user action needed):

```bash
gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"
```

Display: `PAT secret ✅ Set`

### 3c-bis. TruffleHog

AskUserQuestion: **Set up TruffleHog secret scanning** | **Skip**.

yes:
1. CI workflow includes a `secrets` job with `trufflesecurity/trufflehog@main` — it runs automatically on every push and PR (with `--only-verified` to reduce noise).
2. Check if `trufflehog` binary is installed locally (needed for pre-commit hooks):
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
3. Display: `TruffleHog ✅ Secret scanning configured`

skip → Display: `TruffleHog ⏭ Skipped`

### 3c-ter. Dependabot

AskUserQuestion: **Set up Dependabot** (automated dependency updates) | **Skip**.

yes:
1. Auto-detect package manager from `stack.yml` (`package_manager` field).
   Ecosystem map: `uv` / `pip` → `pip` | `bun` / `npm` / `pnpm` / `yarn` → `npm`.
   If unknown → ask: **pip** | **npm** | **Skip**.
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
3. Push via REST API (no local commit needed):
   ```bash
   CONTENT=$(base64 -w0 .github/dependabot.yml 2>/dev/null || base64 .github/dependabot.yml)
   gh api repos/<owner>/<repo>/contents/.github/dependabot.yml \
     --method PUT \
     --field message="chore: add dependabot.yml" \
     --field content="$CONTENT"
   ```
4. Display: `Dependabot ✅ .github/dependabot.yml created (<ecosystem> + github-actions)`

skip → Display: `Dependabot ⏭ Skipped`

### 3d. Branch Protection + Ruleset

AskUserQuestion: **Set up branch protection** | **Skip**.
yes → `bun $I_TS protect-branches --repo <owner/repo>`

This command:
1. Applies branch protection (required `ci` check, strict up-to-date) on main + staging
2. Creates the `PR_Main` ruleset if missing (squash/rebase only, no deletion, no force push, thread resolution required)

Parse result JSON. Display:
- Branch protection: `main ✅, staging ✅` (or ❌ per branch)
- Ruleset: `PR_Main ✅ Created` | `PR_Main ✅ Already exists` | `PR_Main ❌ Failed`

### 3e. Vercel (Optional)

`vercel` ≠ null in disc → AskUserQuestion: **Set up Vercel integration** | **Skip**.
yes → AskUserQuestion for `VERCEL_TOKEN` (free text — explain: Vercel Settings → Tokens).

### 3f. Issue Migration

`issues.orphaned > 0` in disc:
- AskUserQuestion: **Add N open issues to project board** | **Skip**
- yes → `bun $I_TS migrate-issues --owner <owner> --repo <repo> --project-number <N>`
- Parse result JSON. Display: "Added {added}/{total} issues to project board" (mention failures if any).

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

AskUserQuestion: **Confirm** | **Edit a value** | **Abort**.
Edit → ask which value, accept new, re-display, re-confirm.

## Phase 5 — Scaffold

Run: `bun $I_TS scaffold --github-repo <owner/repo> --project-id <PVT_...> --status-field-id <PVTSSF_...> --size-field-id <PVTSSF_...> --priority-field-id <PVTSSF_...> --status-options-json '<json>' --size-options-json '<json>' --priority-options-json '<json>' [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]`

Installs `roxabi` shim at `~/.local/bin/roxabi` (or `~/bin/roxabi`) — self-healing shell script that resolves the latest active dev-core plugin cache at runtime. Run `roxabi dashboard` to launch issues dashboard. Shim survives plugin updates without re-running `/init`.

## Phase 6 — Workspace Registration

Register current project in shared workspace config (enables multi-project dashboard).

1. Check if already registered:
   ```bash
   bun -e "
   import { readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/adapters/workspace-helpers.ts'
   const ws = readWorkspace()
   console.log(ws.projects.some(p => p.repo === process.env.GITHUB_REPO) ? 'registered' : 'not-registered')
   "
   ```

2. already registered → display `workspace.json ✅ Already registered`, skip to Phase 7.

3. ¬registered → AskUserQuestion: **Add to workspace** | **Skip**

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
   Display: `workspace.json ✅ Registered <GITHUB_REPO> at <path>`

5. Skip → display `workspace.json ⏭ Skipped`

## Phase 6b — Bulk Discovery

Scan filesystem for other repos with dev-core configured but ∉ workspace.json.

1. Find candidates:
   ```bash
   # Constrain to $HOME to avoid reading files outside user's home directory
   # maxdepth 6 prevents deep traversal while covering typical monorepo layouts
   find "$HOME" -maxdepth 6 -name ".env" 2>/dev/null \
     | xargs grep -l "^GITHUB_REPO=" 2>/dev/null \
     | sort -u
   ```

2. ∀ found `.env`: extract `GITHUB_REPO`, `GH_PROJECT_ID`, Vercel config:
   ```bash
   grep -E "^(GITHUB_REPO|GH_PROJECT_ID|VERCEL_PROJECT_ID|VERCEL_TEAM_ID)=" <path>/.env
   ```

3. Filter out: current project + already-registered repos (compare against `workspace.json`).

4. ∄ unregistered candidates → skip silently.

5. ∃ candidates → display:
   ```
   Other dev-core projects found:
     [ ] owner/repo-a   (GH_PROJECT_ID: PVT_...)
     [ ] owner/repo-b   (no project board)
     [ ] owner/repo-c   (GH_PROJECT_ID: PVT_...)
   ```
   AskUserQuestion: **Add all** | **Select** | **Skip**

6. Add all / Select → ∀ chosen repo: read `GITHUB_REPO` + `GH_PROJECT_ID` + `VERCEL_PROJECT_ID` + `VERCEL_TEAM_ID` + derive label from repo name, append to `workspace.json` (include `vercelProjectId`/`vercelTeamId` only if ∃ in that repo's `.env`).
   Display: `workspace.json ✅ Added N projects (repo-a, repo-b, ...)`

7. Skip → display `workspace.json ⏭ Bulk discovery skipped`

## Phase 7 — Documentation Scaffolding (Optional)

Scaffold standard documentation directories and minimal template files.

1. Read `docs.path` and `docs.format` from `.claude/stack.yml` (defaults: `docs`, `md`).
2. Check if `{docs.path}/standards/` already exists.
   - exists → display `Docs scaffolding ✅ Already present`, skip.
3. AskUserQuestion: **Scaffold standard docs structure** (architecture/, standards/, guides/ with template files) | **Skip**.
4. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-docs --format <docs.format> --path <docs.path>
   ```
5. Display created dirs and files from JSON result. Format:
   - `Docs scaffolding ✅ Created {filesCreated.length} files in {docsPath}/`

### Phase 7b — Fumadocs App Scaffold (Optional)

Run only if `docs.framework: fumadocs` in `.claude/stack.yml`.

1. AskUserQuestion: **Scaffold Fumadocs app** (`apps/docs/` Next.js app + `docs/` content dir — Mermaid, Shiki, Tailwind v4) | **Skip**
2. If yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs --root <cwd> --docs-path <docs.path>
   ```
   - Display result: `Fumadocs scaffold ✅ Created {filesCreated.length} files in apps/docs/ and {docs.path}/`
   - List created files grouped by directory.
   - ∃ warnings (skipped files) → display each with ⚠️
3. Remind: run `bun install` in `apps/docs/` to install dependencies, then `bun dev` to start the docs server on port 3002.

## Phase 8 — VS Code MDX Preview (Optional)

Run only if `find . -name "*.mdx" -not -path "*/node_modules/*" | head -1` returns a result ∨ `docs.format: mdx` in stack.yml.

1. Check `.vscode/settings.json` for `"*.mdx": "markdown"` under `files.associations`.
2. ∃ → display `VS Code MDX preview ✅ Already configured`, skip.
3. ∄ → AskUserQuestion: **Add VS Code MDX preview support** | **Skip**.
4. yes:
   - ¬`.vscode/settings.json` → create: `{"files.associations": {"*.mdx": "markdown"}}`
   - ∃ → merge `"*.mdx": "markdown"` into existing `files.associations` (preserve all other keys).
   - Display: `VS Code MDX preview ✅ Added`

## Phase 9 — CI Setup

Set up GitHub Actions CI/CD workflows via REST API (no local git needed). Runs last so stack.yml values are available to pre-fill the configuration.

Standard workflow set: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

1. **Check for existing workflows** via REST API:
   ```bash
   gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
   ```
   Check which of the standard files are missing. If all present → display `CI/CD workflows ✅ Already configured` and skip.

2. **Auto-detect from stack.yml** (read `.claude/stack.yml` if it exists):
   - `stack` ← `runtime` field (`bun` → **Bun**, `node` → **Node**, `python` → **Python (uv)**)
   - `test` ← `commands.test` (contains "vitest" → **Vitest**, "jest" → **Jest**, "pytest" → **Pytest**, else → **None**)
   - `deploy` ← `deploy.platform` (`vercel` → **Vercel**, else → **None**)

3. **If any workflows missing**, AskUserQuestion: **Set up CI/CD workflows** | **Skip**

4. **If yes:**
   - AskUserQuestion for stack (pre-select detected value): **Bun** | **Node** | **Python (uv)**
   - AskUserQuestion for test framework (pre-select detected value): **Vitest** | **Jest** | **Pytest** | **None**
   - AskUserQuestion for deploy (pre-select detected value): **Vercel** | **None**
   - Run: `bun $INIT_TS workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy>`
   - Files are pushed directly to the remote repo via GitHub REST API — no commit needed locally.
   - Set the `PAT` secret: `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Enable `allow_auto_merge` on the repo (required for `gh pr merge --auto` to work):
     ```bash
     gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true
     ```
   - Re-trigger auto-merge on any open PRs already carrying the `reviewed` label:
     ```bash
     for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
       gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
       gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
     done
     ```
   - Display: `CI/CD workflows ✅ Created (ci.yml, auto-merge.yml, pr-title.yml)` + `PAT secret ✅ Set` + `allow_auto_merge ✅ Enabled` + `Auto-merge re-triggered on N open PR(s) ✅` (or ⏭ if none)

5. **If skip:** display `CI/CD workflows ⏭ Skipped`

### Phase 9b — Fumadocs Vercel Deployment (Optional)

Run only if `deploy.platform: vercel` ∧ `docs.framework: fumadocs` in `.claude/stack.yml`.

1. Check if `apps/docs/vercel.json` already exists.
   - ∃ → display `Fumadocs Vercel config ✅ Already present`, skip.
2. AskUserQuestion: **Add Vercel deployment config for docs** (`apps/docs/vercel.json`) | **Skip**
3. If yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs-vercel --root <cwd> --orchestrator <build.orchestrator>
   ```
   - `build.orchestrator: turbo` → generates config with `turbo-ignore @repo/docs` (skips Vercel rebuild when docs unchanged)
   - other → generates simple config (`cd apps/docs && bun run build`)
   - Display: `Fumadocs Vercel config ✅ Created apps/docs/vercel.json`
4. Remind: connect `apps/docs/` as a Vercel project (set root directory to `apps/docs` in Vercel dashboard), then set `NEXT_PUBLIC_APP_URL` env var to your app URL.

## Phase 10 — Pre-commit Hooks (Optional)

Catch lint/format/typecheck failures locally before they reach CI.

### 10a — Detect existing hooks

Check in parallel:
```bash
test -f lefthook.yml && echo found || echo missing
test -d .husky && echo found || echo missing
test -f .pre-commit-config.yaml && echo found || echo missing
test -f .git/hooks/pre-commit && echo found || echo missing
```

∃ any → display `Pre-commit hooks ✅ Already configured`, skip to Phase 7 report update.

### 10b — Resolve tool

Read `hooks.tool` from `.claude/stack.yml`.

- `none` → display `Pre-commit hooks ⏭ Disabled in stack.yml`, skip.
- `auto` ∨ key absent → infer from `runtime`:
  - `python` → tool = **pre-commit**
  - `bun` / `node` / `deno` / anything else → tool = **lefthook**
- explicit value (`lefthook`, `pre-commit`, `husky`) → use directly.

### 10c — Offer setup

AskUserQuestion: **Set up `<tool>`** (catches lint/format issues before push) | **Skip**.

### 10d — Install

**lefthook:**

a. Read `commands.lint` and `commands.typecheck` from `.claude/stack.yml` (defaults: `bun run lint` / `bun run typecheck`).
b. Detect stack from `stack.yml` `runtime` field. For Python: license cmd = `uv run tools/license_check.py`. For JS: license cmd = `bun tools/licenseChecker.ts`.
b2. Copy license tools (JS/bun stacks only):
   ```bash
   mkdir -p tools
   cp "${CLAUDE_PLUGIN_ROOT}/tools/licenseChecker.ts" tools/licenseChecker.ts
   # Copy default policy template only if no policy file exists yet
   test -f .license-policy.json || cp "${CLAUDE_PLUGIN_ROOT}/tools/license-policy.json.example" .license-policy.json
   # Gitignore the reports/ output directory
   grep -q 'reports/' .gitignore 2>/dev/null || echo 'reports/' >> .gitignore
   ```
   - Add `"license": "bun tools/licenseChecker.ts"` to `package.json` `scripts` (if not already set).
   Display: `License checker ✅ tools/licenseChecker.ts copied`
c. `bun add -d lefthook`
d. Write `lefthook.yml`:
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
e. `bunx lefthook install`
f. Check if `trufflehog` binary is installed:
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
g. Run license check and offer to generate policy (JS/bun):
   ```bash
   bun tools/licenseChecker.ts --json 2>/dev/null
   ```
   - exit 0 → Display: `License check ✅ All packages compliant`
   - exit 1 → parse violations JSON, display list, AskUserQuestion: **Generate .license-policy.json** | **Skip**
     - yes → write `.license-policy.json` with all violating package names in `allowlist` array, display: `License policy ✅ .license-policy.json created (N packages allowlisted) — review and tighten before production`
     - skip → Display: `License policy ⏭ Skipped — first push will fail until resolved`
h. Display: `Pre-commit hooks ✅ lefthook installed (lint + typecheck + trufflehog on commit, license on push)`

---

**pre-commit (Python):**

a. Read `commands.lint` and `commands.typecheck` from `.claude/stack.yml` (defaults: `ruff check .` / `pyright`).
b. Install:
   ```bash
   uv add --dev pre-commit pip-licenses
   ```
c. Copy license checker script from plugin:
   ```bash
   mkdir -p tools
   cp "${CLAUDE_PLUGIN_ROOT}/tools/license_check.py" tools/license_check.py
   ```
d. Write `.pre-commit-config.yaml`:
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
e. `uv run pre-commit install && uv run pre-commit install --hook-type pre-push`
f. Check if `trufflehog` binary is installed:
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
g. Run license check and offer to generate policy (Python):
   ```bash
   uv run tools/license_check.py --json 2>/dev/null
   ```
   - exit 0 → Display: `License check ✅ All packages compliant`
   - exit 1 → parse violations + unknown JSON fields, display list, AskUserQuestion: **Generate .license-policy.json** | **Skip**
     - yes → write `.license-policy.json` with all violating + unknown package names in `allowlist` array:
       ```json
       {
         "allowlist": ["pkg-a", "pkg-b"],
         "overrides": {}
       }
       ```
       Display: `License policy ✅ .license-policy.json created (N packages allowlisted) — review and tighten before production`
     - skip → Display: `License policy ⏭ Skipped — first push will fail until resolved`
   - exit 2 (pip-licenses missing) → Display: `License check ⏭ pip-licenses not installed — run uv add --dev pip-licenses`
h. Display: `Pre-commit hooks ✅ pre-commit installed (lint + typecheck + trufflehog on commit, license on push)`

## Phase 10b — Marketplace Plugins

Offer additional Roxabi plugins. dev-core is already installed — present the rest grouped by theme, 3 at a time.

For each group below, display the group name + plugin list, then AskUserQuestion: **Install all** | **Pick** | **Skip**.

- **Pick**: AskUserQuestion per plugin: **Install** | **Skip**.
- Install: `claude plugin install <name>` — run for each selected plugin, display result inline.

---

### Group 1 — Dev tools

| Plugin | What it does |
|--------|-------------|
| `compress` | Rewrite agent/skill definitions in compact math/logic notation — cuts token usage |
| `1b1` | Walk a list one by one: brief → decide → act → next. Great for review queues |
| `web-intel` | Scrape Twitter/X, GitHub, YouTube, Reddit, webpages — summarize, analyze, benchmark |

---

### Group 2 — Frontend quality

| Plugin | What it does |
|--------|-------------|
| `react-best-practices` | 58 React/Next.js perf rules across 8 categories, prioritized by impact |
| `composition-patterns` | Avoid boolean prop proliferation — compound components, context providers |
| `web-design-guidelines` | Review UI for accessibility, UX, and Web Interface Guidelines compliance |

---

### Group 3 — Visual output

| Plugin | What it does |
|--------|-------------|
| `visual-explainer` | Self-contained HTML pages with diagrams, visualizations, and data tables |
| `frontend-slides` | Zero-dependency HTML presentations — 12 presets, PPT conversion |
| `image-prompt-generator` | AI image prompts with visual identity and style consistency |

---

### Group 4 — Career & content

| Plugin | What it does |
|--------|-------------|
| `cv` | Generate and adapt CVs from structured JSON, tailored for specific job postings |
| `linkedin-apply` | Scrape LinkedIn jobs and score against your profile — APPLY / REVIEW / SKIP |
| `linkedin-post-generator` | Engaging LinkedIn posts with best practices and visual identity |

---

### Group 5 — Data & productivity

| Plugin | What it does |
|--------|-------------|
| `vault` | Unified local SQLite+FTS5 vault — CRUD and full-text search across Roxabi data |
| `get-invoice-details` | Extract structured data from invoice documents (text or PDF) → JSON |
| `voice-cli` | Author TTS scripts, generate speech, clone voices, transcribe audio |

---

After all groups, display:
```
Marketplace plugins
  installed: compress, web-intel, vault  (or: ⏭ None installed)
```

## Phase 11 — Report

Display final summary:

```
dev-core initialized
====================

  .env              ✅ Written (N variables)
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

Next steps:
  /doctor                Verify full configuration health
  roxabi dashboard       Launch the issues dashboard  (restart shell or: source ~/.bashrc)
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

## Safety Rules

1. **Never overwrite `.env` values** without F or explicit user confirmation
2. **Always AskUserQuestion** before destructive or write operations
3. **Never commit `.env`** — ensure it's in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites
6. **Never commit `.claude/stack.yml`** — only `.claude/stack.yml.example`

$ARGUMENTS
