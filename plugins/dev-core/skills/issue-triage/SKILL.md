---
name: issue-triage
argument-hint: [list | set <num> | create --title "..." [--parent N] [--size S] [--priority P]]
description: Triage/create GitHub issues — set size/priority/status, manage dependencies & parent/child. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion
---

# Issue Triage

Create GitHub issues, assign Size/Priority/Status, manage blockedBy dependencies and parent/child (sub-issue) relationships.

## Instructions

1. **List untriaged issues**:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts list
   ```

2. **Review each issue** and determine appropriate values:
   - **Size**: Estimate effort (XS, S, M, L, XL)
   - **Priority**: Determine urgency (Urgent, High, Medium, Low)
   - **Complexity**: Score 1-10 using the rubric (see [Complexity Scoring](#complexity-scoring))

3. **Set values** for each issue:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <number> --size <S> --priority <P>
   ```

4. **Update status** when needed:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <number> --status "In Progress"
   ```

5. **Create new issues** with optional fields:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create --title "Title" [--body "Body"] [--label "bug,frontend"] [--size M] [--priority High] [--parent 163]
   ```

6. **Use AskUserQuestion** if unsure about Size or Priority for an issue.

## Size Guidelines

| Size | Description | Example |
|------|-------------|---------|
| **XS** | Trivial change, < 1 hour | Typo fix, config tweak |
| **S** | Small task, < 4 hours | Single file change, simple feature |
| **M** | Medium task, 1-2 days | Multi-file feature, requires testing |
| **L** | Large task, 3-5 days | Complex feature, architectural changes |
| **XL** | Very large, > 1 week | Major refactor, new system |

## Priority Guidelines

| Priority | Description | Action |
|----------|-------------|--------|
| **Urgent** (P0) | Blocking or critical | Do immediately |
| **High** (P1) | Important for current milestone | Do this sprint |
| **Medium** (P2) | Should be done soon | Plan for next sprint |
| **Low** (P3) | Nice to have | Backlog |

## Commands

### `list` — Show untriaged issues

| Flag | Description |
|------|-------------|
| *(none)* | Table of issues missing Size or Priority |
| `--json` | JSON output for programmatic use |

### `set <num>` — Update an existing issue

| Flag | Description |
|------|-------------|
| `--size <S>` | Set size (XS, S, M, L, XL) |
| `--priority <P>` | Set priority (Urgent, High, Medium, Low) |
| `--status <S>` | Set status (Backlog, Analysis, Specs, "In Progress", Review, Done) |
| `--blocked-by <N>[,<N>...]` | Add blocked-by dependency |
| `--blocks <N>[,<N>...]` | Add blocking dependency |
| `--rm-blocked-by <N>[,<N>...]` | Remove blocked-by dependency |
| `--rm-blocks <N>[,<N>...]` | Remove blocking dependency |
| `--parent <N>` | Set parent issue (make this a sub-issue of #N) |
| `--add-child <N>[,<N>...]` | Add child sub-issues |
| `--rm-parent` | Remove parent relationship |
| `--rm-child <N>[,<N>...]` | Remove child sub-issues |

### `create` — Create a new issue

| Flag | Description |
|------|-------------|
| `--title "..."` | Issue title (**required**) |
| `--body "..."` | Issue body/description |
| `--label "l1,l2"` | Comma-separated labels |
| `--size <S>` | Set size on creation |
| `--priority <P>` | Set priority on creation |
| `--status <S>` | Set status on creation (default: added to project as-is) |
| `--parent <N>` | Set parent issue on creation |
| `--add-child <N>[,<N>...]` | Add existing issues as children |
| `--blocked-by <N>[,<N>...]` | Set blocked-by on creation |
| `--blocks <N>[,<N>...]` | Set blocking on creation |

## Complexity Scoring

When triaging issues, assess complexity on a 1-10 scale to inform tier determination (S / F-lite / F-full).

Record the score by appending a complexity marker to the issue body:

```bash
# Append complexity score to issue body
BODY=$(gh issue view <number> --json body --jq .body)
gh issue edit <number> --body "$BODY

<!-- complexity: <score> -->"
```

This machine-parseable marker (`<!-- complexity: N -->`) can be retrieved by downstream tools (e.g., `/plan` reads it during planning).

**Factors (each scored 1-10, then weighted):**

| Factor | Weight | 1 (Low) | 5 (Medium) | 10 (High) |
|--------|--------|---------|------------|-----------|
| **Files touched** | 20% | 1-3 files | 5-10 files | 15+ files |
| **Technical risk** | 25% | Known patterns | New library or pattern in 1 domain | New architecture |
| **Architectural impact** | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| **Unknowns count** | 15% | 0 unknowns | 1-2 open questions | 3+ unknowns |
| **Domain breadth** | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**Tier mapping:**

| Score | Tier | Process | Agent Mode |
|-------|------|---------|-----------|
| 1-3 | **S** | Worktree + direct implementation + PR | Single session, no agents |
| 4-6 | **F-lite** | Worktree + subagents + /review | Task subagents (1-2 domain + tester) |
| 7-10 | **F-full** | Bootstrap + worktree + agent team + /review | TeamCreate (3+ agents, test-first) |

The score is advisory. Human judgment overrides. Use `AskUserQuestion` if the score and your intuition disagree.

Reference: [artifacts/analyses/280-token-consumption.mdx](../../../artifacts/analyses/280-token-consumption.mdx) for scoring examples.

## Status Values

| Status | Description |
|--------|-------------|
| **Backlog** | Not yet started, waiting to be picked up |
| **Analysis** | Being researched / analyzed |
| **Specs** | Specification in progress or done |
| **In Progress** | Active development (has worktree/branch) |
| **Review** | In code review / PR open |
| **Done** | Completed and merged |

## Example Workflow

```bash
# 1. List issues to triage
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts list

# 2. Set size and priority
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 42 --size M --priority High

# 3. Update status
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 42 --status "In Progress"

# 4. Set dependencies
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 91 --blocked-by 117
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 117 --blocks 91,118

# 5. Remove dependencies
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 91 --rm-blocked-by 117

# 6. Set parent (make #164 a child of #163)
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 164 --parent 163

# 7. Add children to an epic
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 163 --add-child 164,165,166

# 8. Remove parent relationship
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 164 --rm-parent

# 9. Remove specific children
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set 163 --rm-child 166

# 10. Create a new issue with full setup
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create \
  --title "research: compare against example/repo" \
  --body "Deep analysis of example/repo" \
  --label "research" \
  --size S --priority Medium \
  --parent 163

# 11. Create an epic with existing children
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create \
  --title "epic: improve CI pipeline" \
  --size L --priority High \
  --add-child 150,151,152
```

## Configuration

Run `/init` to auto-detect and populate these env vars. Project field operations (status, size, priority) require a configured project board — without it, issue creation and dependency management still work but field updates are skipped with a clear error message.

Environment variables (set by `/init` in `.env`):
- `PROJECT_ID` — GitHub Project V2 ID (**required** for field updates)
- `STATUS_FIELD_ID` — Project field ID for Status
- `SIZE_FIELD_ID` — Project field ID for Size
- `PRIORITY_FIELD_ID` — Project field ID for Priority
- `STATUS_OPTIONS_JSON` — JSON map of status names to option IDs
- `SIZE_OPTIONS_JSON` — JSON map of size names to option IDs
- `PRIORITY_OPTIONS_JSON` — JSON map of priority names to option IDs

$ARGUMENTS
