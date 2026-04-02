---
name: issues
argument-hint: [--dashboard | --stop | --json | --tree | -T | --priority]
description: List/dashboard GitHub issues — status, dependencies, backlog. Triggers: "list issues" | "show issues" | "backlog" | "issue dashboard" | "what's blocked".
version: 0.2.0
allowed-tools: Bash, Read
---

# Issues

Let: δ := dashboard | Φ := CLAUDE_PLUGIN_ROOT

List open GitHub issues with Status, Size, Priority, dependency relationships.

## Instructions

**`--dashboard` ∈ $ARGUMENTS →**

1. Stop existing; launch daemon:
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

2. Verify: `curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:3333`
3. Inform: "Dashboard at http://localhost:3333 — refresh for latest. Stop with `/issues --stop`."
4. **Stop here** — ¬run CLI table.

---

**`--stop` ∈ $ARGUMENTS →**

1. Stop δ:
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

**`--tree` ∨ `-T` ∈ $ARGUMENTS →** Pass flag to fetch script (step 1 below), present output verbatim. **Stop here** — ¬show WIP section.

---

**Default (CLI table):**

1. Fetch:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/fetch-issues.ts
   ```

2. Present output in code block. ¬reformat — script produces formatted table. **Display ALL lines verbatim — ¬truncate, summarize, or omit rows.**

3. Recommendations (2-3 lines max):
   - ✅ ∧ P0/P1 → prioritize
   - Missing Size ∨ Priority → suggest `/issue-triage`
   - Many blocked → identify critical blocker

4. Work in progress:
   ```bash
   git worktree list
   git branch --list | grep -v -E '^\*?\s*(main|master)$'
   gh pr list --state open --json number,title,headRefName,isDraft,labels
   ```

   Present as "Work in Progress": worktrees beyond main; feature branches related to issues; PRs: title + PR# + status, branch indented with `└`.
   **PR status**: `DRAFT` if draft | `REVIEWED` if label "reviewed" ∃ | else `REVIEW`

## Options

| Flag | Description |
|------|-------------|
| `--dashboard` | Launch live HTML δ as background daemon |
| `--stop` | Stop δ daemon |
| (none) | Table sorted by Priority, then Size |
| `--tree` / `-T` | Compact tree view — full titles, inline metadata, all depths |
| `--json` | Raw JSON |
| `--priority` | Sort by priority (default) |
| `--size` | Sort by size |
| `--title-length=N` | Truncate titles at N chars (default: 55) |

## Output Columns

| Column | Description |
|--------|-------------|
| `#` | Issue number |
| `Title` | Title with children as tree (├/└) |
| `Status` | Backlog, Analysis, Specs, In Prog, Review, Done |
| `Size` | XS, S, M, L, XL |
| `Pri` | P0, P1, P2, P3 |
| `⚡` | Block status |
| `Deps` | Dependency list |

## Block Status (⚡)

| Icon | Meaning |
|------|---------|
| `✅` | Ready — no open blockers |
| `⛔` | Blocked — waiting on others |
| `🔓` | Blocking — others depend on this |

## Dependency Icons (Deps)

| Icon | Meaning |
|------|---------|
| `⛔#N` | Blocked by #N (open) |
| `🔓#N` | Blocks #N |
| `✅#N` | Was blocked by #N (closed) |

## Output Sections

| Section | Description |
|---------|-------------|
| Header | `● N issues` |
| Table | Sorted by Priority, then Size |
| Legend | Icon meanings |
| Chains | Dependency visualization |
| Recommendations | Priority + blocker analysis |
| Work in Progress | Worktrees, branches, PRs |

## Dependencies

Displays dependency relationships. To **modify** deps → use `/issue-triage`.

## Configuration

`/init` auto-detects env vars. `GITHUB_REPO` from git remote if ¬set. `GH_PROJECT_ID` required for project board.

- `GH_PROJECT_ID` — GitHub Project V2 ID (**required**)
- `GITHUB_REPO` — `owner/repo` (auto-detected)

$ARGUMENTS
