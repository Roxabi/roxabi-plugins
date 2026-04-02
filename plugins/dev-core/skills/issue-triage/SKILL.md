---
name: issue-triage
argument-hint: [list | set <num> | create --title "..." [--parent N] [--size S] [--priority P]]
description: Triage/create GitHub issues — set size/priority/status, manage dependencies & parent/child. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue".
version: 0.2.0
allowed-tools: Bash, Read, ToolSearch
---

# Issue Triage

Let: τ := `bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts` | κ := complexity score

Create GitHub issues, assign Size/Priority/Status, manage blockedBy dependencies and parent/child relationships.

## Instructions

1. List all open issues: `τ list` | List untriaged only: `τ list --untriaged`
2. ∀ issue: determine Size, Priority, κ (see [Complexity Scoring](#complexity-scoring))
3. Set values: `τ set <number> --size <S> --priority <P>`
4. Update status: `τ set <number> --status "In Progress"`
5. Create issues: `τ create --title "Title" [--body "Body"] [--label "bug,frontend"] [--size M] [--priority High] [--parent 163]`
6. → DP(B)if unsure about Size ∨ Priority.

## Size Guidelines

| Size | Description | Example |
|------|-------------|---------|
| **XS** | Trivial, < 1 hour | Typo fix, config tweak |
| **S** | Small, < 4 hours | Single file change, simple feature |
| **M** | Medium, 1-2 days | Multi-file feature, requires testing |
| **L** | Large, 3-5 days | Complex feature, architectural changes |
| **XL** | Very large, > 1 week | Major refactor, new system |

## Priority Guidelines

| Priority | Description | Action |
|----------|-------------|--------|
| **Urgent** (P0) | Blocking or critical | Do immediately |
| **High** (P1) | Important for current milestone | Do this sprint |
| **Medium** (P2) | Should be done soon | Plan for next sprint |
| **Low** (P3) | Nice to have | Backlog |

## Commands

### `list` — Show open issues

| Flag | Description |
|------|-------------|
| *(none)* | Tree of all open issues with N-level parent-child hierarchy. Parents with ≥1 closed child show `… ✓ Done`. |
| `--untriaged` | Flat table of issues missing Size or Priority |
| `--json` | JSON output (all open issues); combine with `--untriaged` to filter |

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

Assess κ ∈ [1,10] to inform tier (S / F-lite / F-full). Record by appending to issue body:

```bash
BODY=$(gh issue view <number> --json body --jq .body)
gh issue edit <number> --body "$BODY

<!-- complexity: <score> -->"
```

`<!-- complexity: N -->` is machine-parseable; downstream tools (e.g. `/plan`) read it.

**Factors (each 1-10, weighted):**

| Factor | Weight | 1 (Low) | 5 (Medium) | 10 (High) |
|--------|--------|---------|------------|-----------|
| **Files touched** | 20% | 1-3 files | 5-10 files | 15+ files |
| **Technical risk** | 25% | Known patterns | New library/pattern in 1 domain | New architecture |
| **Architectural impact** | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| **Unknowns count** | 15% | 0 unknowns | 1-2 open questions | 3+ unknowns |
| **Domain breadth** | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `κ = round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**Tier mapping:**

| Score | Tier | Process | Agent Mode |
|-------|------|---------|-----------|
| 1-3 | **S** | Worktree + direct implementation + PR | Single session, no agents |
| 4-6 | **F-lite** | Worktree + subagents + /code-review | Task subagents (1-2 domain + tester) |
| 7-10 | **F-full** | Bootstrap + worktree + agent team + /code-review | TeamCreate (3+ agents, test-first) |

κ is advisory. Human judgment overrides. → DP(B)if score ≠ intuition.

See [Tier Classification Reference](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/tier-classification.md) for full rules.
Reference: `artifacts/analyses/280-token-consumption.mdx` for scoring examples.

## Status Values

| Status | Description |
|--------|-------------|
| **Backlog** | Not yet started |
| **Analysis** | Being researched / analyzed |
| **Specs** | Specification in progress or done |
| **In Progress** | Active development (has worktree/branch) |
| **Review** | In code review / PR open |
| **Done** | Completed and merged |

## Example Workflow

```bash
τ list
τ list --untriaged
τ set 42 --size M --priority High
τ set 42 --status "In Progress"
τ set 91 --blocked-by 117
τ set 117 --blocks 91,118
τ set 91 --rm-blocked-by 117
τ set 164 --parent 163
τ set 163 --add-child 164,165,166
τ set 164 --rm-parent
τ set 163 --rm-child 166
τ create \
  --title "research: compare against example/repo" \
  --body "Deep analysis of example/repo" \
  --label "research" \
  --size S --priority Medium \
  --parent 163
τ create \
  --title "epic: improve CI pipeline" \
  --size L --priority High \
  --add-child 150,151,152
```

## Configuration

Run `/init` to auto-detect and populate env vars. Field operations (status, size, priority) require a configured project board — without it, issue creation and dependency management still work but field updates are skipped with a clear error.

| Var | Purpose | Required |
|-----|---------|---------|
| `GH_PROJECT_ID` | GitHub Project V2 ID | ✅ field updates |
| `STATUS_FIELD_ID` | Project field ID for Status | ✅ field updates |
| `SIZE_FIELD_ID` | Project field ID for Size | ✅ field updates |
| `PRIORITY_FIELD_ID` | Project field ID for Priority | ✅ field updates |
| `STATUS_OPTIONS_JSON` | JSON map status names → option IDs | ✅ field updates |
| `SIZE_OPTIONS_JSON` | JSON map size names → option IDs | ✅ field updates |
| `PRIORITY_OPTIONS_JSON` | JSON map priority names → option IDs | ✅ field updates |

$ARGUMENTS
