---
name: github-setup
argument-hint: '[--force] [--hub-enroll]'
description: 'Connect project to GitHub Project V2 board — discover or create board, labels, branch protection, workspace registration. Triggers: "github setup" | "setup github project" | "connect github board" | "setup project board".'
version: 0.1.0
allowed-tools: Bash, Read, ToolSearch
---

# GitHub Setup

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  F    := `--force` flag present in `$ARGUMENTS`
  PID  := selected project ID (PVT_...)
  disc := JSON result of `bun $I_TS discover`
  ω    := owner/repo (from disc)
  δ    := `.claude/dev-core.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

Connect to GitHub: Project V2 board, field IDs, labels, branch protection, Vercel, issue migration, workspace registration. Standalone or called by `/init`.

## Phase 1 — Auto-Discover Configuration

Run: `bun $I_TS discover`. Parse → extract `owner`, `repo`, `projects`, `fields`, `labels`, `workflows`, `protection`, `vercel`, `env`.

### 1a. Project Board

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

### 1a-bis. Project Workflows

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

### 1b. Labels

`labels.missing` ≠ ∅ → Ask: **Create all** | **Type only** | **Area only** | **Skip**.
Run: `bun $I_TS labels --repo <owner/repo> --scope <all|type|area>`

### 1c. Branch Protection + Ruleset

Ask: **Set up branch protection** | **Skip**.
yes → `bun $I_TS protect-branches --repo <owner/repo>`

Applies: branch protection (required `ci`, strict up-to-date) on main + staging; `PR_Main` ruleset if missing (squash/rebase/merge, ¬deletion/force-push, thread resolution — merge commits needed for staging→main). Display per-branch ✅/❌ + Ruleset status.

### 1d. Vercel (Optional)

`vercel` ≠ null in disc → Ask: **Set up Vercel** | **Skip**.
yes → Ask for `VERCEL_TOKEN` (free text — Vercel Settings → Tokens).

### 1e. Issue Migration

`issues.orphaned > 0` in disc → Ask: **Add N open issues to board** | **Skip**.
yes → `bun $I_TS migrate-issues --owner <owner> --repo <repo> --project-number <N>`. Parse → D("Issues", "Added {added}/{total} to board").

### 1f. Hub Enroll (opt-in)

`--hub-enroll` ∈ $ARGUMENTS → per-repo enrollment into the `Roxabi Hub` hub project (cross-repo taxonomy SSoT — see [Issue taxonomy SSoT](../../references/issue-taxonomy.md)).

Ask: **Enroll this repo in Roxabi Hub** | **Skip**.

yes → `bun $I_TS hub-enroll --repo <owner/repo>`

Delegates to `init.ts hub-enroll` (Phase 1+2 infra from #120):
- Verifies 10 org-level Issue Types exist (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`). Fails fast if any missing — run `bun $I_TS hub-bootstrap` first.
- Pushes `.github/workflows/hub-add.yml` via GH contents API (idempotent create-or-update).
- Checks milestones `M0`, `M1`, `M2` per repo. **Missing milestones → warn only** (no mutation). Seed via `make milestones-sync` (external sibling task, out of scope here).
- Verifies a test issue surfaces in the hub project before reporting success.

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <owner/name>` | auto-detect | Target repo for enrollment. |
| `--dry-run` | off | Log planned actions; no mutation. |

D✅("Hub enroll") on success; D⏭ on skip. Missing milestones → D("Hub enroll", "⚠️ enrolled; missing milestones: M1,M2 — run make milestones-sync").

## Phase 2 — Confirm Values

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

## Phase 3 — Write Config

### 3a. Write δ (primary config)

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

### 3b. Scaffold (legacy .env + shim + artifacts)

Run: `bun $I_TS scaffold --github-repo <owner/repo> --project-id <PVT_...> --status-field-id <PVTSSF_...> --size-field-id <PVTSSF_...> --priority-field-id <PVTSSF_...> --status-options-json '<json>' --size-options-json '<json>' --priority-options-json '<json>' [--vercel-token <token>] [--vercel-project-id <id>] [--vercel-team-id <id>] [--force]`

Also writes `.env`/`.env.example` for backward compat. δ takes precedence at runtime via `loadDevCoreConfig()`. Installs `roxabi` shim at `~/.local/bin/roxabi` (or `~/bin/roxabi`) — self-healing, survives plugin updates. Run `roxabi dashboard` to launch.

## Phase 4 — Workspace Registration

Register in shared workspace config (enables multi-project dashboard).

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

## Phase 5 — Bulk Discovery

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

3. Filter: current project + already-registered. ∄ candidates → skip silently.

4. ∃ candidates → display list, Ask: **Add all** | **Select** | **Skip**.

5. Add → ∀ chosen: derive label from repo name, append to workspace.json (Vercel IDs only if ∃). D("workspace.json", "✅ Added N projects (repo-a, repo-b, ...)").

6. Skip → D⏭("Bulk discovery").

## Phase 6 — Report

```
GitHub Setup Complete
=====================

  dev-core.yml      ✅ Written (.claude/dev-core.yml)
  .env              ✅ Written (N variables, legacy fallback)
  .env.example      ✅ Written
  Project board     ✅ Created / Detected / ⏭ Skipped
  Issue migration   ✅ N issues added to board / ⏭ Skipped
  Labels            ✅ N labels created / ⏭ Skipped
  Project workflows ✅ Displayed / ⏭ Skipped
  Branch protection ✅ Created / ⏭ Skipped
  Hub enroll        ✅ Enrolled / ⚠️ Enrolled w/ milestone gaps / ⏭ Skipped
  Ruleset PR_Main   ✅ Created / ✅ Already exists / ⏭ Skipped
  roxabi shim       ✅ Installed (~/.local/bin/roxabi)
  PATH              ✅ ~/.local/bin added to .bashrc/.zshrc  (or ⏭ already present)
  artifacts/        ✅ Created
  .gitignore        ✅ .env added
  workspace.json    ✅ Registered <repo> / ⏭ Skipped
  bulk discovery    ✅ Added N projects / ⏭ Skipped / ⏭ No others found

Next: run /ci-setup to configure GitHub Actions and pre-commit hooks.
```

## Safety Rules

1. **Never overwrite δ or `.env` values** without F or explicit confirmation
2. **Always present decisions via protocol** before destructive or write operations
3. **Never commit δ or `.env`** — ensure both are in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites

## Related

- [Taxonomy SSoT](../../references/issue-taxonomy.md) — field set, cross-repo behavior, org-bootstrap contract for hub project + Issue Types

$ARGUMENTS
