# issues

List GitHub issues with status, size, priority, dependency relationships, and a live web dashboard.

## Why

GitHub's web UI doesn't show custom fields (Size, Priority, Status) in a scan-friendly format, and the dependency graph is buried in issue bodies. `/issues` renders a structured CLI table with all metadata, dependency icons, and a WIP section showing active worktrees, branches, and PRs — so you can plan the next session in seconds.

## Usage

```
/issues                     CLI table (sorted by Priority, then Size)
/issues --dashboard         Launch live web dashboard (background daemon)
/issues --stop              Stop the dashboard daemon
/issues --show 42           Full details for issue #42
/issues --tree              Compact tree view with all parent/child depths
/issues --digest            Epic progress + parallel execution order digest
/issues --json              Raw JSON output
```

Triggers: `"list issues"` | `"show issues"` | `"backlog"` | `"issue dashboard"` | `"what's blocked"` | `"what should I work on"` | `"digest"` | `"roadmap"`

## Output columns

| Column | Description |
|--------|-------------|
| `#` | Issue number |
| `Title` | Title with child tree (├/└) |
| `Status` | Backlog → Analysis → Specs → In Prog → Review → Done |
| `Size` | XS, S, M, L, XL |
| `Pri` | P0, P1, P2, P3 |
| `⚡` | ✅ Ready / ⛔ Blocked / 🔓 Blocking |
| `Deps` | Dependency list with open/closed icons |

## Digest mode (`--digest` / `-D`)

Shows epic progress and a parallel execution order — which issues can be worked on simultaneously, grouped by dependency chain into lanes.

## Dashboard

```
/issues --dashboard
```

Starts a background HTTP server (port 3333) with a live-updating HTML dashboard. Refresh in your browser for the latest state. Stop with `/issues --stop`.

## Configuration

Requires `GH_PROJECT_ID` (auto-set by `/init`). `GITHUB_REPO` is auto-detected from git remote.
