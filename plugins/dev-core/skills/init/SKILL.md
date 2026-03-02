---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — auto-detect GitHub Project V2, set up dashboard, env vars, artifacts. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.2.0
allowed-tools: Bash
---

# Init

Configure the current project to work with dev-core. Auto-detects GitHub repo, Project V2 board, field IDs, and optionally Vercel integration. Writes `.env`, `.env.example`, dashboard script in `package.json`, and creates the `artifacts/` directory.

Safe to re-run — merges with existing config unless `--force` is used.

## Instructions

All data (label definitions, workflow templates, protection payloads) lives in TypeScript. This SKILL.md orchestrates by running CLI subcommands and presenting results.

Set `INIT_TS="${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts"` and `DOCTOR_TS="${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts"` for all commands below.

### Phase 1 — Parse Input + Idempotency

1. Check if `$ARGUMENTS` contains `--force`. Store as `FORCE` flag.
2. Check for `package.json`: `test -f package.json`. If missing, abort: "No package.json found. Run from your project root."
3. If not force, check for existing dev-core config: `grep -c 'dev-core' .env 2>/dev/null || echo "0"`. If > 0, AskUserQuestion: **Re-configure** (same as --force) | **Skip** (abort).

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

#### 3b. Labels

If `labels.missing` is non-empty, AskUserQuestion: **Create all labels** | **Type labels only** | **Area labels only** | **Skip labels**.

Run: `bun $INIT_TS labels --repo <owner/repo> --scope <all|type|area|priority>`

#### 3c. Workflows

If `workflows.missing` is non-empty, AskUserQuestion: **Set up CI/CD workflows** | **Skip**.

If yes:
1. AskUserQuestion for stack: **Bun** | **Node**
2. AskUserQuestion for test framework: **Vitest** | **Jest** | **None**
3. AskUserQuestion for deploy: **Vercel** | **None**

Run: `bun $INIT_TS workflows --stack bun --test vitest --deploy vercel`

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
    PROJECT_ID          = PVT_kwHO...
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

Run: `bun $INIT_TS scaffold --github-repo <owner/repo> --project-id <PVT_...> --status-field-id <PVTSSF_...> --size-field-id <PVTSSF_...> --priority-field-id <PVTSSF_...> --status-options-json '<json>' --size-options-json '<json>' --priority-options-json '<json>' --dashboard-path <resolved-path>/skills/issues/dashboard.ts [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]`

Resolve `--dashboard-path` using `$CLAUDE_PLUGIN_ROOT/skills/issues/dashboard.ts`.

### Phase 6 — Verify

Run: `bun $DOCTOR_TS`

Display the doctor output as the final verification.

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
  CI/CD workflows   ✅ Created / ⏭ Skipped
  Branch protection ✅ Created / ⏭ Skipped
  package.json      ✅ "dashboard" script added
  artifacts/        ✅ Created
  .gitignore        ✅ .env added

Next steps:
  bun run dashboard      Launch the issues dashboard
  /doctor                Verify configuration health
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

### Phase 8 — Stack Configuration

Set up `.claude/stack.yml` so dev-core agents can work without hardcoded paths.

1. **Check for existing stack.yml:** `test -f .claude/stack.yml && echo exists || echo missing`

2. **If missing:**
   - Copy the template: `cp "${CLAUDE_PLUGIN_ROOT}/../../stack.yml.example" .claude/stack.yml`
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
   - If `.claude/stack.yml.example` does not exist, copy: `cp "${CLAUDE_PLUGIN_ROOT}/../../stack.yml.example" .claude/stack.yml.example`
   - Display: ".claude/stack.yml.example created ✅ (commit this file)"

## Safety Rules

1. **Never overwrite `.env` values** without `--force` or explicit user confirmation
2. **Always AskUserQuestion** before destructive or write operations
3. **Never commit `.env`** — ensure it's in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites
6. **Never commit `.claude/stack.yml`** — only `.claude/stack.yml.example`

$ARGUMENTS
