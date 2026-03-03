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

- If **0 projects**: AskUserQuestion: **Create project board** | **Skip**. If Create: `bun $INIT_TS create-project --owner <owner> --repo <repo>`. Parse result for project ID and field IDs.
- If **1 project**: auto-select, use its ID from discover result.
- If **multiple projects**: present numbered list, AskUserQuestion to pick one.

If no project selected, field IDs stay empty. If project selected but fields missing from discover, run `create-project` to create them.

After project selection, re-run `bun $INIT_TS discover` to refresh field IDs for the selected project. If Status/Size/Priority fields are still missing after re-discovery, run `bun $INIT_TS create-project --owner <owner> --repo <repo>` to create them (handles pre-existing Status field gracefully).

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

AskUserQuestion: **Enable all** | **Select** | **Skip**.

- If **Enable all**: for each disabled workflow, run `bun $INIT_TS enable-workflow --workflow-id <PWF_...>`. Display "✅ Enabled N workflows".
- If **Select**: present a numbered list, ask which ones (comma-separated), then enable only those.
- If **Skip**: continue without enabling any.

#### 3b. Labels

If `labels.missing` is non-empty, AskUserQuestion: **Create all labels** | **Type labels only** | **Area labels only** | **Skip labels**.

Run: `bun $INIT_TS labels --repo <owner/repo> --scope <all|type|area|priority>`

#### 3c. Workflows

If `workflows.missing` is non-empty, AskUserQuestion: **Set up CI/CD workflows** | **Skip**.

If yes:
1. AskUserQuestion for stack: **Bun** | **Node** | **Python (uv)**
2. AskUserQuestion for test framework: **Vitest** | **Jest** | **Pytest** | **None**
3. AskUserQuestion for deploy: **Vercel** | **None**

Run: `bun $INIT_TS workflows --stack bun --test vitest --deploy vercel`

Note: Python workflow generates a `ci.yml` running `uv run ruff check .` and `uv run pytest`.

#### 3d. Branch Protection

AskUserQuestion: **Set up branch protection** | **Skip**.

Run: `bun $INIT_TS protect-branches --repo <owner/repo>`

#### 3e. Vercel (Optional)

If `vercel` is non-null in discover result, AskUserQuestion: **Set up Vercel integration** | **Skip**. If yes, ask for `VERCEL_TOKEN` via AskUserQuestion (free text — explain: Vercel Settings → Tokens).

#### 3f. Issue Migration

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
  Workflows:            ci.yml, deploy-preview (created / skipped)
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

### Phase 7 — Report

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
  CI/CD workflows   ✅ Created / ⏭ Skipped
  Branch protection ✅ Created / ⏭ Skipped
  roxabi shim       ✅ Installed (~/.local/bin/roxabi)
  PATH              ✅ ~/.local/bin added to .bashrc/.zshrc  (or ⏭ already present)
  artifacts/        ✅ Created
  .gitignore        ✅ .env added
  workspace.json    ✅ Registered <repo> / ⏭ Skipped
  bulk discovery    ✅ Added N projects / ⏭ Skipped / ⏭ No others found

Next steps:
  /stack-setup           Configure stack for agents (auto-discovers your project)
  /doctor                Verify full configuration health
  roxabi dashboard       Launch the issues dashboard  (restart shell or: source ~/.bashrc)
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

### Phase 8 — Stack Configuration

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

### Phase 9 — VS Code MDX Preview (Optional)

Only run if `.mdx` files exist in the project (`find . -name "*.mdx" -not -path "*/node_modules/*" | head -1`) or `docs.format: mdx` in stack.yml.

1. Check `.vscode/settings.json` for `"*.mdx": "markdown"` under `files.associations`.
2. If already present → display `VS Code MDX preview ✅ Already configured` and skip.
3. If missing → AskUserQuestion: **Add VS Code MDX preview support** (adds `"*.mdx": "markdown"` to `.vscode/settings.json`) | **Skip**.
4. If yes:
   - If `.vscode/settings.json` does not exist, create it: `{"files.associations": {"*.mdx": "markdown"}}`
   - If it exists, merge `"*.mdx": "markdown"` into the existing `files.associations` object (preserve all other keys).
   - Display: `VS Code MDX preview ✅ Added`

Update Phase 7 report to include:
```
  VS Code MDX preview   ✅ Added / ✅ Already configured / ⏭ Skipped / ⏭ No .mdx files found
```

### Phase 10 — Pre-commit Hooks (Optional)

Catch lint/format/typecheck failures locally before they reach CI.

#### 10a — Detect existing hooks

Check all three in parallel:
```bash
test -f lefthook.yml && echo found || echo missing          # lefthook
test -d .husky && echo found || echo missing                 # husky
test -f .pre-commit-config.yaml && echo found || echo missing  # pre-commit
test -f .git/hooks/pre-commit && echo found || echo missing  # raw git hook
```

If any found → display `Pre-commit hooks ✅ Already configured` and skip to Phase 11.

#### 10b — Resolve tool

Read `hooks.tool` from `.claude/stack.yml` (just written in Phase 8) if present.

If value is `none` → display `Pre-commit hooks ⏭ Disabled in stack.yml` and skip.

If value is `auto` or key absent, infer from `runtime`:
- `python` → tool = **pre-commit**
- `bun` / `node` / `deno` / anything else → tool = **lefthook**

If `hooks.tool` is an explicit value (`lefthook`, `pre-commit`, `husky`) → use it directly.

#### 10c — Offer setup

AskUserQuestion: **Set up `<tool>`** (catches lint/format issues before push) | **Skip**.

#### 10d — Install

**lefthook path:**

a. Read `commands.lint` and `commands.typecheck` from `.claude/stack.yml` (defaults: `bun run lint` / `bun run typecheck`).

b. Install:
   ```bash
   bun add -d lefthook
   ```

c. Write `lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>
   ```

d. Activate:
   ```bash
   bunx lefthook install
   ```

e. Display: `Pre-commit hooks ✅ lefthook installed (lint + typecheck on commit)`

---

**pre-commit path (Python):**

a. Read `commands.lint` and `commands.typecheck` from `.claude/stack.yml` (defaults: `ruff check .` / `mypy .`).

b. Install pre-commit:
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

d. Activate:
   ```bash
   pre-commit install
   ```

e. Display: `Pre-commit hooks ✅ pre-commit installed (lint + typecheck on commit)`

Update Phase 7 report to include:
```
  Pre-commit hooks      ✅ lefthook installed / ✅ pre-commit installed / ✅ Already configured / ⏭ Disabled / ⏭ Skipped
```

## Safety Rules

1. **Never overwrite `.env` values** without `--force` or explicit user confirmation
2. **Always AskUserQuestion** before destructive or write operations
3. **Never commit `.env`** — ensure it's in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites
6. **Never commit `.claude/stack.yml`** — only `.claude/stack.yml.example`

$ARGUMENTS
