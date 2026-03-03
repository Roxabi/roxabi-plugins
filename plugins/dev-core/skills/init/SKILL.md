---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — auto-detect GitHub Project V2, set up dashboard launcher, env vars, artifacts. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.5.0
allowed-tools: Bash
---

# Init

Configure the current project to work with dev-core. Auto-detects GitHub repo, Project V2 board, field IDs, and optionally Vercel integration. Writes `.env`, `.env.example`, `.claude/run-dashboard.ts` launcher, and creates the `artifacts/` directory.

Safe to re-run — merges with existing config unless `--force` is used.

## Instructions

All data (label definitions, workflow templates, protection payloads) lives in TypeScript. This SKILL.md orchestrates by running CLI subcommands and presenting results.

Set `INIT_TS="${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts"` and `DOCTOR_TS="${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts"` for all commands below.

### Phase 1 — Parse Input + Idempotency

1. Check if `$ARGUMENTS` contains `--force`. Store as `FORCE` flag.
2. If not force, check for existing dev-core config: `grep -c 'dev-core' .env 2>/dev/null || echo "0"`. If > 0, AskUserQuestion: **Re-configure** (same as --force) | **Skip** (abort).

### Phase 2 — Prerequisites

Run: `bun $INIT_TS prereqs`

Parse the JSON output. Display a summary table with ✅/❌ for bun, gh, git remote.

If any check fails, show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

AskUserQuestion: **Abort** | **Continue anyway** (with warning some features won't work).

### Phase 3 — Auto-Discover Configuration

Run: `bun $INIT_TS discover`

Parse the JSON. Extract `owner`, `repo`, `projects`, `fields`, `labels`, `workflows`, `protection`, `vercel`, `env`.

#### 3a. Project Board

- If **0 projects**: AskUserQuestion: **Create project board** | **Skip**. If Create: AskUserQuestion: **Technical** (Size/Priority fields, CI/Vercel integration) | **Company** (Quarter/Pillar fields, no CI/Vercel). Run `bun $INIT_TS create-project --owner <owner> --repo <repo> [--type technical|company]`. Parse result for project ID and field IDs.
- If **1 project**: auto-select, use its ID from discover result.
- If **multiple projects**: present numbered list, AskUserQuestion to pick one.

If no project selected, field IDs stay empty. If project selected but fields missing from discover, run `create-project` to create them.

After project selection, re-run `bun $INIT_TS discover` to refresh field IDs for the selected project. If Status/Size/Priority fields are still missing after re-discovery, run `bun $INIT_TS create-project --owner <owner> --repo <repo> [--type technical|company]` to create them (handles pre-existing Status field gracefully).

#### create-project options

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--type` | `technical` \| `company` | `technical` | Sets project type in workspace.json. |

- **technical**: col2=Size, col3=Priority. CI/Vercel/dev links shown. Sort by priority.
- **company**: col2=Quarter, col3=Pillar. No CI/Vercel/dev links. Sort by quarter ascending.

#### 3a-bis. Project Workflows

If a project was selected or created, run: `bun $INIT_TS list-workflows --project-id <PVT_...>`

Parse the JSON array. Display a table:

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

If any workflows are disabled, display:

> ⚠️ GitHub's API does not support enabling project workflows programmatically.
> Enable them manually at: `https://github.com/orgs/<owner>/projects/<number>/workflows`

#### 3b. Labels

If `labels.missing` is non-empty, AskUserQuestion: **Create all labels** | **Type labels only** | **Area labels only** | **Skip labels**.

Run: `bun $INIT_TS labels --repo <owner/repo> --scope <all|type|area|priority>`

#### 3c. GitHub Actions Workflows

Check which workflow files exist in the repo:

```bash
gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
```

The standard set is: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

If any are missing, AskUserQuestion: **Set up GitHub Actions workflows** | **Skip**.

If yes:
1. AskUserQuestion for stack: **Bun** | **Node** | **Python (uv)**
2. AskUserQuestion for test framework: **Vitest** | **Jest** | **Pytest** | **None**
3. AskUserQuestion for deploy: **Vercel** | **None**

Run: `bun $INIT_TS workflows --owner <owner> --repo <repo> --stack bun --test vitest --deploy vercel`

This pushes all workflow files directly to the remote repo via GitHub REST API — no local git commit needed. Files are created or updated idempotently.

To add only the generic workflows (`auto-merge.yml` + `pr-title.yml`) without touching `ci.yml`:

```bash
bun $INIT_TS push-workflows --owner <owner> --repo <repo>
```

Note: `auto-merge.yml` requires a `PAT` secret in the repo (a personal access token with `repo` + `workflow` scopes). Remind the user to add it at: `https://github.com/<owner>/<repo>/settings/secrets/actions`.

#### 3d. Branch Protection

AskUserQuestion: **Set up branch protection** | **Skip**.

Run: `bun $INIT_TS protect-branches --repo <owner/repo>`

#### 3d. Vercel (Optional)

If `vercel` is non-null in discover result, AskUserQuestion: **Set up Vercel integration** | **Skip**. If yes, ask for `VERCEL_TOKEN` via AskUserQuestion (free text — explain: Vercel Settings → Tokens).

#### 3e. Issue Migration

If `issues.orphaned > 0` in the discover result:
- AskUserQuestion: **Add N open issues to project board** | **Skip**
- If yes: `bun $INIT_TS migrate-issues --owner <owner> --repo <repo> --project-number <N>`
- Parse result JSON. Display: "Added {added}/{total} issues to project board" (mention failures if any).

### Phase 4 — Confirm Values

Display all discovered/selected values in a summary table:

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

If "Edit a value", ask which value to change, accept new value, re-display, re-confirm.

### Phase 5 — Scaffold

Run: `bun $INIT_TS scaffold --github-repo <owner/repo> --project-id <PVT_...> --status-field-id <PVTSSF_...> --size-field-id <PVTSSF_...> --priority-field-id <PVTSSF_...> --status-options-json '<json>' --size-options-json '<json>' --priority-options-json '<json>' [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]`

The scaffold step installs a `roxabi` shim at `~/.local/bin/roxabi` (or `~/bin/roxabi`) — a self-healing shell script that resolves the latest active dev-core plugin cache at runtime. Run `roxabi dashboard` to launch the issues dashboard. The shim survives plugin updates without re-running `/init`.

### Phase 6 — Workspace Registration

Register the current project in the shared workspace config so the multi-project dashboard shows issues from all your repos in one view.

1. **Check if already registered** (uses `GITHUB_REPO` from Phase 3):
   ```bash
   bun -e "
   import { readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/workspace.ts'
   const ws = readWorkspace()
   console.log(ws.projects.some(p => p.repo === process.env.GITHUB_REPO) ? 'registered' : 'not-registered')
   "
   ```

2. **If already registered:** display `workspace.json ✅ Already registered` and skip to Phase 7.

3. **If not registered:** AskUserQuestion: **Add to workspace** (enables multi-project dashboard) | **Skip**

4. **If add:**
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

5. **If skip:** display `workspace.json ⏭ Skipped`

### Phase 6b — Bulk Discovery

Scan the filesystem for other repos with dev-core configured but not yet in workspace.json.

1. **Find candidates:**
   ```bash
   # Constrain to $HOME to avoid reading files outside user's home directory
   # maxdepth 6 prevents deep traversal while covering typical monorepo layouts
   find "$HOME" -maxdepth 6 -name ".env" 2>/dev/null \
     | xargs grep -l "^GITHUB_REPO=" 2>/dev/null \
     | sort -u
   ```

2. **For each found `.env`**, extract `GITHUB_REPO`, `GH_PROJECT_ID`, and Vercel config:
   ```bash
   grep -E "^(GITHUB_REPO|GH_PROJECT_ID|VERCEL_PROJECT_ID|VERCEL_TEAM_ID)=" <path>/.env
   ```

3. **Filter out**: current project + already-registered repos (compare against `workspace.json`).

4. **If no unregistered candidates:** skip silently.

5. **If candidates found**, display:
   ```
   Other dev-core projects found:
     [ ] owner/repo-a   (GH_PROJECT_ID: PVT_...)
     [ ] owner/repo-b   (no project board)
     [ ] owner/repo-c   (GH_PROJECT_ID: PVT_...)
   ```
   AskUserQuestion: **Add all** | **Select** | **Skip**

6. **If Add all or Select:** for each chosen repo, read its `GITHUB_REPO` + `GH_PROJECT_ID` + `VERCEL_PROJECT_ID` + `VERCEL_TEAM_ID` + derive label from repo name, then append to `workspace.json` (include `vercelProjectId`/`vercelTeamId` only if present in that repo's `.env`).

   Display: `workspace.json ✅ Added N projects (repo-a, repo-b, ...)`

7. **If Skip:** display `workspace.json ⏭ Bulk discovery skipped`

### Phase 7 — Stack Configuration

Set up `.claude/stack.yml` so dev-core agents can work without hardcoded paths.

1. **Check for existing stack.yml:** `test -f .claude/stack.yml && echo exists || echo missing`

2. **If missing:**
   - Copy the template: `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml`
   - Walk the user through filling in critical fields. AskUserQuestion for each of:
     - **Backend path** (e.g., `apps/api`) — `backend.path` in stack.yml
     - **Frontend path** (e.g., `apps/web`) — `frontend.path` in stack.yml
     - **Package manager** — **bun** | **npm** | **pnpm** | **yarn**
     - **Test command** (e.g., `bun run test`) — `commands.test` in stack.yml
   - Open `.claude/stack.yml` and fill in the confirmed values.
   - Inform the user: "Fill in the remaining fields in `.claude/stack.yml` before running agents."

3. **Add @import to CLAUDE.md:**
   - Check if first line of `CLAUDE.md` is `@.claude/stack.yml`: `head -1 CLAUDE.md`
   - If not present, prepend it: write `@.claude/stack.yml\n` before the existing content.
   - Display: "Added `@.claude/stack.yml` import to CLAUDE.md ✅"

4. **Add stack.yml to .gitignore:**
   - Check: `grep -q '\.claude/stack\.yml' .gitignore 2>/dev/null && echo found || echo missing`
   - If missing, append: `.claude/stack.yml` to `.gitignore`.
   - Display: "Added `.claude/stack.yml` to .gitignore ✅"

5. **Copy stack.yml.example to project root (committed reference):**
   - If `.claude/stack.yml.example` does not exist, copy: `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml.example`
   - Display: ".claude/stack.yml.example created ✅ (commit this file)"

### Phase 8 — VS Code MDX Preview (Optional)

Only run if `.mdx` files exist in the project (`find . -name "*.mdx" -not -path "*/node_modules/*" | head -1`) or `docs.format: mdx` in stack.yml.

1. Check `.vscode/settings.json` for `"*.mdx": "markdown"` under `files.associations`.
2. If already present → display `VS Code MDX preview ✅ Already configured` and skip.
3. If missing → AskUserQuestion: **Add VS Code MDX preview support** (adds `"*.mdx": "markdown"` to `.vscode/settings.json`) | **Skip**.
4. If yes:
   - If `.vscode/settings.json` does not exist, create it: `{"files.associations": {"*.mdx": "markdown"}}`
   - If it exists, merge `"*.mdx": "markdown"` into the existing `files.associations` object (preserve all other keys).
   - Display: `VS Code MDX preview ✅ Added`

### Phase 9 — CI Setup

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
   - Note: `auto-merge.yml` requires a `PAT` secret in the repo. Remind user to add it at: `https://github.com/<owner>/<repo>/settings/secrets/actions`
   - Display: `CI/CD workflows ✅ Created (ci.yml, auto-merge.yml, pr-title.yml)`

5. **If skip:** display `CI/CD workflows ⏭ Skipped`

### Phase 10 — Report

Display final summary:

```
dev-core initialized
====================

  .env              ✅ Written (N variables)
  .env.example      ✅ Written
  Project board     ✅ Created / Detected / ⏭ Skipped
  Issue migration   ✅ N issues added to board / ⏭ Skipped
  Labels            ✅ N labels created / ⏭ Skipped
  Project workflows ⚠️ Enable manually at https://github.com/orgs/<owner>/projects/<number>/workflows
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

Next steps:
  /doctor                Verify full configuration health
  roxabi dashboard       Launch the issues dashboard  (restart shell or: source ~/.bashrc)
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

## Safety Rules

1. **Never overwrite `.env` values** without `--force` or explicit user confirmation
2. **Always AskUserQuestion** before destructive or write operations
3. **Never commit `.env`** — ensure it's in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites
6. **Never commit `.claude/stack.yml`** — only `.claude/stack.yml.example`

$ARGUMENTS
