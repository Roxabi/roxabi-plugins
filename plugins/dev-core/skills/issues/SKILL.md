---
name: issues
argument-hint: [--dashboard | --stop | --json | --priority]
description: List/dashboard GitHub issues — status, dependencies, backlog. Triggers: "list issues" | "show issues" | "backlog" | "issue dashboard" | "what's blocked".
version: 0.1.0
allowed-tools: Bash, Read
---

# Issues

Let: δ := dashboard | Φ := CLAUDE_PLUGIN_ROOT

List open GitHub issues with Status, Size, Priority, and dependency relationships.

## Instructions

**`--dashboard` ∈ $ARGUMENTS →**

1. Stop existing instance; launch daemon:
   ```bash
   DASH_DIR="${CLAUDE_PLUGIN_ROOT}/skills/issues"
   PID_FILE="$DASH_DIR/.dashboard.pid"
   LOG_FILE="$DASH_DIR/.dashboard.log"

   # Kill previous instance if running
   if [ -f "$PID_FILE" ]; then
     OLD_PID=$(cat "$PID_FILE")
     kill "$OLD_PID" 2>/dev/null && echo "Stopped previous dashboard (PID $OLD_PID)" || true
     rm -f "$PID_FILE"
     sleep 1
   fi

   # Launch as detached daemon
   nohup bun "${CLAUDE_PLUGIN_ROOT}/skills/issues/dashboard.ts" > "$LOG_FILE" 2>&1 &
   disown

   # Wait for PID file to appear (confirms server started)
   for i in 1 2 3 4 5; do
     [ -f "$PID_FILE" ] && break
     sleep 1
   done

   if [ -f "$PID_FILE" ]; then
     echo "Dashboard running (PID $(cat "$PID_FILE"))"
   else
     echo "ERROR: Dashboard failed to start. Check $LOG_FILE"
   fi
   ```

2. Verify server responds:
   ```bash
   curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:3333
   ```

3. Tell user: "Dashboard running at http://localhost:3333 — refresh for latest data. Stop with `/issues --stop`."
4. **Stop here** — do NOT run the CLI table below.

---

**`--stop` ∈ $ARGUMENTS →**

1. Stop the running δ:
   ```bash
   PID_FILE="${CLAUDE_PLUGIN_ROOT}/skills/issues/.dashboard.pid"
   if [ -f "$PID_FILE" ]; then
     kill "$(cat "$PID_FILE")" 2>/dev/null && echo "Dashboard stopped." || echo "Dashboard was not running."
     rm -f "$PID_FILE"
   else
     echo "No dashboard running."
   fi
   ```
2. **Stop here.**

---

**Default (CLI table output):**

1. Fetch issues:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/fetch-issues.ts
   ```

2. Present output in a code block (triple backticks). Do NOT reformat or interpret — script produces well-formatted table.

3. Add brief recommendations (2-3 lines max):
   - Issues with ✅ ∧ priority P0/P1 → prioritize
   - Issues missing Size ∨ Priority → suggest `/issue-triage`
   - Identify critical blocker if many issues blocked

4. Show work in progress:
   ```bash
   git worktree list
   git branch --list | grep -v -E '^\*?\s*(main|master)$'
   gh pr list --state open --json number,title,headRefName,isDraft,labels
   ```

   Present as "Work in Progress" section:
   - Worktrees if any beyond main
   - Feature branches related to issues (look for issue numbers in branch names)
   - PRs formatted as: title + PR# + status on first line; branch name indented with `└`
   - **PR status**: `DRAFT` if draft | `REVIEWED` if label "reviewed" ∃ | otherwise `REVIEW`

## Options

| Flag | Description |
|------|-------------|
| `--dashboard` | Launch live HTML δ as background daemon |
| `--stop` | Stop running δ daemon |
| (none) | Table sorted by Priority, then Size |
| `--json` | Raw JSON for programmatic use |
| `--priority` | Sort by priority (default) |
| `--size` | Sort by size instead |
| `--title-length=N` | Truncate titles at N chars (default: 55) |

## Output Columns

| Column | Description |
|--------|-------------|
| `#` | Issue number |
| `Title` | Issue title with children as tree (├/└) |
| `Status` | Backlog, Analysis, Specs, In Prog, Review, Done |
| `Size` | XS, S, M, L, XL |
| `Pri` | P0, P1, P2, P3 |
| `⚡` | Block status (see below) |
| `Deps` | Detailed dependency list |

## Block Status (⚡ column)

| Icon | Meaning |
|------|---------|
| `✅` | Ready — no open blockers |
| `⛔` | Blocked — waiting on other issues |
| `🔓` | Blocking — other issues depend on this |

## Dependency Icons (Deps column)

| Icon | Meaning |
|------|---------|
| `⛔#N` | Blocked by issue #N (open) |
| `🔓#N` | Blocks issue #N |
| `✅#N` | Was blocked by #N (now closed) |

## Example Output

```
● 12 issues

  #    │ Title                                         │ Status     │ Size │ Pri │ ⚡ │ Deps
  #33  │ feat(i18n): Implement TanStack Start          │ In Progress│ M    │ P0  │ ✅ │ -
       │   ├ #34 chore(i18n): Add CI workflow...       │ Todo       │ XS   │ P0  │ ✅ │ -
       │   └ #35 feat(i18n): Add middleware...         │ Todo       │ S    │ P0  │ ✅ │ -
  #24  │ Feature: RBAC                                 │ Todo       │ M    │ P1  │ ⛔ │ ⛔#19 ⛔#21 🔓#25
  #19  │ Feature: Auth + Users                         │ Todo       │ L    │ P1  │ 🔓 │ 🔓#21 🔓#22 🔓#24

  ⛔=blocked  🔓=blocking  ✅=ready

  Chains:
  #19 Auth + Users ──► #21 Multi-tenant
                               └──► #22 Audit Logs
                               └──► #23 Notifications
  #28 Coding Standards ──► #12 Claude Code
```

**Recommendations:**
- Priority focus: #33 (i18n) is P0 and ready
- Critical blocker: #19 blocks 5 features

**Work in Progress:**
```
Worktrees:
  /home/user/project           abc1234 [main]
  /home/user/project-33        def5678 [feat/33-i18n]

Branches:
  feat/33-i18n
  feat/19-auth

PRs:
  #42  Add i18n support                    DRAFT
       └ feat/33-i18n
  #45  Fix auth token refresh              REVIEWED
       └ feat/19-auth
  #48  Add notification service            REVIEW
       └ feat/23-notifications
```

## Output Sections

| Section | Description |
|---------|-------------|
| Header | `● N issues` — total open issues |
| Table | Issues sorted by Priority, then Size |
| Legend | Icon meanings |
| Chains | Dependency visualization |
| Recommendations | Priority and blocker analysis |
| Work in Progress | Worktrees, branches, open PRs |

## Dependencies

This skill **displays** dependency relationships (blockedBy/blocking). To **modify** dependencies (add/remove blockers, set parent/child), use `/issue-triage` instead.

## Configuration

Run `/init` to auto-detect and populate env vars. `GITHUB_REPO` auto-detected from git remote if not set. `GH_PROJECT_ID` required for project board data.

- `GH_PROJECT_ID` — GitHub Project V2 ID (**required**)
- `GITHUB_REPO` — `owner/repo` format (auto-detected from git remote)

$ARGUMENTS
