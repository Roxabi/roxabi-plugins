# issue-triage

Create and triage GitHub issues — set size, priority, status, and manage parent/child/blocker relationships.

## Why

Raw GitHub issues lack structure. `/issue-triage` adds Size (XS→XL), Priority (P0→P3), Status, and dependency links — making the backlog plannable and giving downstream skills (`/dev`, `/plan`) the metadata they need to tier and prioritize work.

## Usage

```
/issue-triage list                           List all open issues (tree view)
/issue-triage list --untriaged               Show issues missing Size or Priority
/issue-triage set 42 --size M --priority High
/issue-triage set 42 --status "In Progress"
/issue-triage set 91 --blocked-by 117
/issue-triage set 164 --parent 163
/issue-triage create --title "..." --size S --priority Medium --parent 163
```

Triggers: `"triage"` | `"create issue"` | `"set size"` | `"set priority"` | `"blocked by"` | `"set parent"` | `"sub-issue"` | `"file an issue"` | `"open an issue"`

## Size Guidelines

| Size | Description |
|------|-------------|
| **XS** | Trivial, < 1 hour |
| **S** | Small, < 4 hours |
| **M** | Medium, 1–2 days |
| **L** | Large, 3–5 days |
| **XL** | Very large, > 1 week |

## Priority Guidelines

| Priority | Action |
|----------|--------|
| **Urgent** (P0) | Do immediately |
| **High** (P1) | Do this sprint |
| **Medium** (P2) | Plan for next sprint |
| **Low** (P3) | Backlog |

## Complexity Scoring

Assigns a κ ∈ [1,10] score to determine implementation tier:

| Score | Tier | Mode |
|-------|------|------|
| 1–3 | S | Single session, direct |
| 4–6 | F-lite | 1–2 subagents |
| 7–10 | F-full | Full agent team |

## Status Values

`Backlog` → `Analysis` → `Specs` → `In Progress` → `Review` → `Done`

## Configuration

Requires a configured GitHub Project V2 board (run `/init` first). Field updates (Size, Priority, Status) need `GH_PROJECT_ID`, `STATUS_FIELD_ID`, `SIZE_FIELD_ID`, `PRIORITY_FIELD_ID` — all auto-detected by `/init`.
