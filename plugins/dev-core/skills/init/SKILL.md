---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — auto-detect GitHub Project V2, set up dashboard launcher, env vars, artifacts. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.5.0
allowed-tools: Bash
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

AskUserQuestion: **Enable all** | **Select** | **Skip**.
- Enable all → ∀ disabled workflow: `bun $I_TS enable-workflow --workflow-id <PWF_...>`. Display "✅ Enabled N workflows".
- Select → numbered list, ask which (comma-separated), enable only those.
- Skip → continue.

### 3b. Labels

`labels.missing` ≠ ∅ → AskUserQuestion: **Create all labels** | **Type labels only** | **Area labels only** | **Skip labels**.
Run: `bun $I_TS labels --repo <owner/repo> --scope <all|type|area|priority>`

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

### 3d. Branch Protection

AskUserQuestion: **Set up branch protection** | **Skip**.
yes → `bun $I_TS protect-branches --repo <owner/repo>`

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

  Labels:               15 labels (created / skipped)
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
   import { readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/workspace.ts'
   const ws = readWorkspace()
   console.log(ws.projects.some(p => p.repo === process.env.GITHUB_REPO) ? 'registered' : 'not-registered')
   "
   ```

2. already registered → display `workspace.json ✅ Already registered`, skip to Phase 7.

3. ¬registered → AskUserQuestion: **Add to workspace** | **Skip**

4. Add:
   ```bash
   bun -e "
   import { getWorkspacePath, readWorkspace, writeWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/workspace.ts'
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

## Phase 7 — Stack Configuration

Set up `.claude/stack.yml` so dev-core agents work without hardcoded paths.

1. `test -f .claude/stack.yml && echo exists || echo missing`

2. missing:
   - `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml`
   - AskUserQuestion ∀ critical field:
     - **Backend path** (e.g., `apps/api`) → `backend.path`
     - **Frontend path** (e.g., `apps/web`) → `frontend.path`
     - **Package manager** → **bun** | **npm** | **pnpm** | **yarn**
     - **Test command** (e.g., `bun run test`) → `commands.test`
   - Write confirmed values into `.claude/stack.yml`.
   - Inform: "Fill in the remaining fields in `.claude/stack.yml` before running agents."

3. Add @import to CLAUDE.md:
   - `head -1 CLAUDE.md` → ¬`@.claude/stack.yml` → prepend `@.claude/stack.yml\n`.
   - Display: "Added `@.claude/stack.yml` import to CLAUDE.md ✅"

4. Add stack.yml to .gitignore:
   - `grep -q '\.claude/stack\.yml' .gitignore 2>/dev/null && echo found || echo missing`
   - missing → append `.claude/stack.yml` to `.gitignore`.
   - Display: "Added `.claude/stack.yml` to .gitignore ✅"

5. Copy stack.yml.example (committed reference):
   - ¬`.claude/stack.yml.example` → `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml.example`
   - Display: ".claude/stack.yml.example created ✅ (commit this file)"

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
   - After pushing, automatically set the `PAT` secret: `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Display: `CI/CD workflows ✅ Created (ci.yml, auto-merge.yml, pr-title.yml)` + `PAT secret ✅ Set`

5. **If skip:** display `CI/CD workflows ⏭ Skipped`

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
b. `bun add -d lefthook`
c. Write `lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>
   ```
d. `bunx lefthook install`
e. Display: `Pre-commit hooks ✅ lefthook installed (lint + typecheck on commit)`

---

**pre-commit (Python):**

a. Read `commands.lint` and `commands.typecheck` from `.claude/stack.yml` (defaults: `ruff check .` / `mypy .`).
b. Install:
   ```bash
   pip install pre-commit
   # or if uv available: uv add --dev pre-commit
   ```
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
   ```
d. `pre-commit install`
e. Display: `Pre-commit hooks ✅ pre-commit installed (lint + typecheck on commit)`

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
  Project workflows ✅ N enabled / ⏭ Skipped
  Branch protection ✅ Created / ⏭ Skipped
  roxabi shim       ✅ Installed (~/.local/bin/roxabi)
  PATH              ✅ ~/.local/bin added to .bashrc/.zshrc  (or ⏭ already present)
  artifacts/        ✅ Created
  .gitignore        ✅ .env added
  workspace.json    ✅ Registered <repo> / ⏭ Skipped
  bulk discovery    ✅ Added N projects / ⏭ Skipped / ⏭ No others found
  stack.yml         ✅ Configured / ✅ Already exists
  VS Code MDX preview   ✅ Added / ✅ Already configured / ⏭ Skipped / ⏭ No .mdx files found
  CI/CD workflows   ✅ Created / ✅ Already configured / ⏭ Skipped
  Pre-commit hooks      ✅ lefthook installed / ✅ pre-commit installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped

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
