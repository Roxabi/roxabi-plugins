---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — auto-detect GitHub Project V2, set up dashboard, env vars, artifacts. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.1.0
disable-model-invocation: true
allowed-tools: Bash, AskUserQuestion, Read, Write, Edit, Glob
---

# Init

Configure the current project to work with dev-core. Auto-detects GitHub repo, Project V2 board, field IDs, and optionally Vercel integration. Writes `.env`, `.env.example`, dashboard script in `package.json`, and creates the `artifacts/` directory.

Safe to re-run — merges with existing config unless `--force` is used.

## Instructions

### Phase 1 — Parse Input + Idempotency

1. Check if `$ARGUMENTS` contains `--force`. Store as `FORCE` flag.
2. Check for `package.json` in the current directory:
   ```bash
   test -f package.json && echo "found" || echo "missing"
   ```
   If missing, abort: "No package.json found. Run this from your project root."

3. If `FORCE` is false, check for existing dev-core config:
   ```bash
   grep -c 'dev-core' .env 2>/dev/null || echo "0"
   ```
   If > 0, inform the user that dev-core is already configured. AskUserQuestion:
   - **Re-configure** — re-run all phases (same as `--force`)
   - **Skip** — abort with message "Already configured. Use `--force` to re-run."

### Phase 2 — Check Prerequisites

Run all checks:

```bash
# 1. Bun
command -v bun && bun --version || echo "MISSING: bun"

# 2. GitHub CLI + auth
command -v gh && gh auth status 2>&1 || echo "MISSING: gh"

# 3. Git remote
git remote get-url origin 2>/dev/null || echo "MISSING: git remote"
```

For each failure, collect the error. Present a summary:

```
Prerequisites
=============
  bun           ✅ 1.x.x
  gh            ✅ Logged in as user
  git remote    ✅ git@github.com:owner/repo.git
```

If any check fails, show what's missing with install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

AskUserQuestion: **Abort** (fix first) | **Continue anyway** (with warning that some features will not work).

### Phase 3 — Auto-Discover Configuration

#### 3a. GITHUB_REPO

Parse owner/repo from the git remote URL:

```bash
git remote get-url origin
```

Handle both formats:
- SSH: `git@github.com:owner/repo.git` → `owner/repo`
- HTTPS: `https://github.com/owner/repo.git` → `owner/repo`

Strip `.git` suffix.

#### 3b. PROJECT_ID + Project Number

List the owner's GitHub Project V2 boards:

```bash
gh project list --owner <owner> --format json --limit 20
```

- If **0 projects**: Warn that issues/triage skills require a Project V2 board. AskUserQuestion: **Skip project setup** | **Abort**. If skipped, leave PROJECT_ID empty.
- If **1 project**: Auto-select it. Extract `number` and `id` (the `PVT_...` node ID).
- If **multiple projects**: Present a numbered list. AskUserQuestion to pick one.

#### 3c. Field IDs + Option IDs

Once project number is known, fetch fields:

```bash
gh project field-list <project-number> --owner <owner> --format json
```

For each expected field (Status, Size, Priority):
1. Find the field by name in the JSON output. Extract its `id` (the `PVTSSF_...` node ID).
2. If the field has `options` (single-select), extract each option's `name` and `id`.
3. Build JSON maps: `{"Backlog": "abc123", "Analysis": "def456", ...}`

If a field is not found, warn: "No '{name}' field found in project — related features will not work."

Store discovered values:
- `STATUS_FIELD_ID`, `SIZE_FIELD_ID`, `PRIORITY_FIELD_ID`
- `STATUS_OPTIONS_JSON`, `SIZE_OPTIONS_JSON`, `PRIORITY_OPTIONS_JSON`

#### 3d. Vercel (Optional)

Check for `.vercel/project.json`:

```bash
cat .vercel/project.json 2>/dev/null
```

If found, extract `projectId` and `orgId`. AskUserQuestion: **Set up Vercel integration** | **Skip Vercel**.

If the user wants Vercel, ask for `VERCEL_TOKEN` via AskUserQuestion (free text input — explain where to get it: Vercel Settings → Tokens).

If `.vercel/project.json` not found, skip Vercel entirely with a note: "No .vercel/project.json found. Vercel dashboard panel will be disabled."

### Phase 4 — Confirm Values

Display all discovered values in a summary table:

```
dev-core Configuration
======================

  GitHub:
    GITHUB_REPO         = owner/repo              (git remote)
    PROJECT_ID          = PVT_kwHO...             (gh project list)
    STATUS_FIELD_ID     = PVTSSF_lAH...           (project fields)
    SIZE_FIELD_ID       = PVTSSF_lAH...           (project fields)
    PRIORITY_FIELD_ID   = PVTSSF_lAH...           (project fields)

  Options:
    Status  = Backlog, Analysis, Specs, In Progress, Review, Done
    Size    = XS, S, M, L, XL
    Priority = P0 - Urgent, P1 - High, P2 - Medium, P3 - Low

  Vercel:
    VERCEL_PROJECT_ID   = prj_...                 (.vercel/project.json)
    VERCEL_TEAM_ID      = team_...                (.vercel/project.json)
    VERCEL_TOKEN        = (provided)

  Dashboard:
    Script path         = <resolved-plugin-path>/skills/issues/dashboard.ts
```

AskUserQuestion: **Confirm** | **Edit a value** | **Abort**.

If "Edit a value", ask which value to change, accept the new value, re-display the table, and re-confirm.

### Phase 5 — Scaffold

#### 5a. Write `.env`

If `.env` exists, read it first. Merge dev-core values — do **not** overwrite existing non-dev-core lines. If a dev-core variable already exists in `.env`, overwrite it only if `--force` was used.

Append or write:

```env
# --- dev-core: GitHub Project V2 ---
GITHUB_REPO=owner/repo
PROJECT_ID=PVT_kwHO...
STATUS_FIELD_ID=PVTSSF_...
SIZE_FIELD_ID=PVTSSF_...
PRIORITY_FIELD_ID=PVTSSF_...

# --- dev-core: Field option IDs (auto-detected by /init) ---
STATUS_OPTIONS_JSON={"Backlog":"id1","Analysis":"id2",...}
SIZE_OPTIONS_JSON={"XS":"id1","S":"id2",...}
PRIORITY_OPTIONS_JSON={"P0 - Urgent":"id1","P1 - High":"id2",...}

# --- dev-core: Vercel (optional) ---
VERCEL_TOKEN=
VERCEL_PROJECT_ID=prj_...
VERCEL_TEAM_ID=team_...
```

If Vercel was skipped, comment out the Vercel section.

#### 5b. Write `.env.example`

Same structure as `.env` but with placeholder values and descriptive comments:

```env
# --- dev-core: GitHub Project V2 ---
# Run /init to auto-detect these values
GITHUB_REPO=owner/repo
PROJECT_ID=PVT_...
STATUS_FIELD_ID=PVTSSF_...
SIZE_FIELD_ID=PVTSSF_...
PRIORITY_FIELD_ID=PVTSSF_...

# --- dev-core: Field option IDs (auto-detected by /init) ---
STATUS_OPTIONS_JSON={}
SIZE_OPTIONS_JSON={}
PRIORITY_OPTIONS_JSON={}

# --- dev-core: Vercel (optional — for dashboard deployments panel) ---
VERCEL_TOKEN=
VERCEL_PROJECT_ID=
VERCEL_TEAM_ID=

# --- dev-core: GitHub token (optional — falls back to `gh auth token`) ---
GITHUB_TOKEN=
```

If `.env.example` exists, merge the dev-core section (same merge logic as `.env`).

#### 5c. Add dashboard script to package.json

Read `package.json`. Check if `scripts.dashboard` exists:
- If exists and not `--force`: AskUserQuestion — **Overwrite** | **Keep existing**
- If exists and `--force`: overwrite silently

Add or update:

```json
"dashboard": "bun <CLAUDE_PLUGIN_ROOT>/skills/issues/dashboard.ts"
```

Where `<CLAUDE_PLUGIN_ROOT>` is replaced with the actual resolved absolute path from the `CLAUDE_PLUGIN_ROOT` environment variable at init time.

**Write the updated package.json** preserving formatting (read, modify the `scripts` object, write back).

#### 5d. Create artifacts directory

```bash
mkdir -p artifacts/frames artifacts/analyses artifacts/specs artifacts/plans
```

#### 5e. Ensure .env is in .gitignore

```bash
grep -qxF '.env' .gitignore 2>/dev/null || echo '.env' >> .gitignore
```

### Phase 6 — Verify (Smoke Test)

Run a quick check to confirm the configuration works:

```bash
# Test GitHub Project API access
gh project item-list <project-number> --owner <owner> --limit 1 --format json
```

Report results:

```
Verification
============
  GitHub Project API   ✅ Connected (fetched 1 item)
  Dashboard script     ✅ Path exists
  Vercel API           ⏭ Skipped (no token)
```

If the project API test fails, show the error and suggest: "Check that `gh auth status` shows the correct account and that the project exists."

### Phase 7 — Report

Display final summary:

```
dev-core initialized
====================

  .env              ✅ Written (N variables)
  .env.example      ✅ Written
  package.json      ✅ "dashboard" script added
  artifacts/        ✅ Created (frames, analyses, specs, plans)
  .gitignore        ✅ .env added

Next steps:
  bun run dashboard      Launch the issues dashboard
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
```

## Options

| Flag | Description |
|------|-------------|
| (none) | Interactive setup with auto-detection |
| `--force` | Re-run all phases, overwrite existing config |

## Safety Rules

1. **Never overwrite `.env` values** without `--force` or explicit user confirmation
2. **Always AskUserQuestion** before writing to any file
3. **Never commit `.env`** — ensure it's in `.gitignore`
4. **Never store secrets in `.env.example`** — use empty placeholder values
5. **Idempotent** — safe to re-run, merges rather than overwrites

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No GitHub projects | Skip project setup, warn that issues/triage skills won't work |
| Field not found in project | Warn per field, continue with other fields |
| `.env` exists with non-dev-core vars | Merge — only touch dev-core section |
| `package.json` has no `scripts` key | Create the `scripts` object |
| `.vercel/project.json` missing | Skip Vercel, note in report |
| Monorepo with multiple package.json | Use the one in the current directory |

$ARGUMENTS
