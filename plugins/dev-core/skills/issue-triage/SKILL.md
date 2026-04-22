---
name: issue-triage
argument-hint: [list | set <num> | create --title "..." [--parent N] [--size S] [--priority P] | migrate <audit-schema|backfill|rewrite-titles|revert>]
description: Triage/create GitHub issues — set size/priority/status/lane/type, manage dependencies & parent/child, migrate legacy data. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue" | "file an issue" | "log a bug" | "open an issue" | "file a bug" | "add issue" | "new issue" | "set lane" | "set type" | "migrate" | "backfill" | "audit schema".
version: 0.3.0
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
| `--blocked-by <REF>[,<REF>...]` | Add blocked-by dependency. REF = `#N` or `owner/repo#N` |
| `--blocks <REF>[,<REF>...]` | Add blocking dependency. REF = `#N` or `owner/repo#N` |
| `--rm-blocked-by <REF>[,<REF>...]` | Remove blocked-by dependency |
| `--rm-blocks <REF>[,<REF>...]` | Remove blocking dependency |
| `--parent <REF>` | Set parent issue. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add child sub-issues |
| `--rm-parent` | Remove parent relationship |
| `--rm-child <REF>[,<REF>...]` | Remove child sub-issues |
| `--lane <L>` | Set lane on hub project (optional, additive). Valid: `a1`, `a2`, `a3`, `b`, `c1`, `c2`, `c3`, `d`–`o`, `standalone` |
| `--type <T>` | Set org issueType (optional, additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor` |

### `create` — Create a new issue

| Flag | Description |
|------|-------------|
| `--title "..."` | Issue title (**required**) |
| `--body "..."` | Issue body/description |
| `--label "l1,l2"` | Comma-separated labels |
| `--size <S>` | Set size on creation |
| `--priority <P>` | Set priority on creation |
| `--status <S>` | Set status on creation (default: added to project as-is) |
| `--parent <REF>` | Set parent issue on creation. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add existing issues as children |
| `--blocked-by <REF>[,<REF>...]` | Set blocked-by on creation |
| `--blocks <REF>[,<REF>...]` | Set blocking on creation |

### `migrate` — Schema validation and data migration

> Operational context (7-day soak, 7 enrolled repos, serial-per-repo rollout, `flagged.txt` review gate): `artifacts/specs/121-dual-write-migration-spec.mdx`

#### `migrate audit-schema`

Validates that the live hub project's Size/Lane/Priority/Status single-select fields match the local `*_OPTIONS` constants.

```bash
τ migrate audit-schema
```

- Exits 0 on match; exits 1 with a field-by-field diff on any drift.

#### `migrate backfill --repo OWNER/REPO`

Walks open issues in the repo, maps legacy labels/title-prefixes to hub fields via `LEGACY_LABEL_MAP`, and writes field values. Idempotent — skips already-set fields.

```bash
τ migrate backfill --repo OWNER/REPO
τ migrate backfill --repo OWNER/REPO --dry-run
τ migrate backfill --repo OWNER/REPO --snapshot artifacts/migration/backfill-snapshot-YYYYMMDD-HHMM.json
```

- Writes `artifacts/migration/backfill-snapshot-<YYYYMMDD-HHMM>.json` + `flagged.txt` for manual review.

#### `migrate rewrite-titles --repo OWNER/REPO`

Strips conventional-commit prefixes (e.g. `feat:`, `fix(scope):`) from open issue titles. Idempotent.

```bash
τ migrate rewrite-titles --repo OWNER/REPO
τ migrate rewrite-titles --repo OWNER/REPO --dry-run
τ migrate rewrite-titles --repo OWNER/REPO --snapshot artifacts/migration/rewrite-snapshot-<ts>.json
```

- Writes `artifacts/migration/rewrite-snapshot-<ts>.json`; `--dry-run` prints changes without applying.

#### `migrate revert --snapshot PATH`

Reads a backfill or rewrite snapshot and inverts the mutations. Idempotent.

```bash
τ migrate revert --snapshot artifacts/migration/backfill-snapshot-20240101-1200.json
τ migrate revert --snapshot artifacts/migration/rewrite-snapshot-20240101-1200.json
```

- Restores all mutated fields/titles to their pre-migration values.

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

# Cross-repo dependencies (owner/repo#N format)
τ set 42 --blocked-by Roxabi/lyra#728
τ set 42 --blocks Roxabi/voiceCLI#94

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

# Lane and type (additive, optional)
τ set 42 --lane b
τ set 42 --type feat
τ set 42 --size M --priority High --lane c1 --type fix

# Migrate
τ migrate audit-schema
τ migrate backfill --repo Roxabi/my-repo --dry-run
τ migrate backfill --repo Roxabi/my-repo
τ migrate rewrite-titles --repo Roxabi/my-repo --dry-run
τ migrate rewrite-titles --repo Roxabi/my-repo
τ migrate revert --snapshot artifacts/migration/backfill-snapshot-20240101-1200.json
```

## Chain Position

- **Phase:** Frame
- **Predecessor:** — (entry point)
- **Successor:** `/frame`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Success via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce `/frame`. `/dev` re-scans and advances.
- **Success standalone:** print one line: `Done. Next: /frame --issue N`. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

## Configuration

Run `/init` to auto-detect and populate env vars. Field operations (status, size, priority) require a configured project board — without it, issue creation and dependency management still work but field updates are skipped with a clear error.

| Var | Purpose | Required |
|-----|---------|---------|
| `GH_PROJECT_ID` | GitHub Project V2 ID | ✅ field updates |
| `STATUS_FIELD_ID` | Project field ID for Status | ✅ field updates |
| `SIZE_FIELD_ID` | Project field ID for Size | ✅ field updates |
| `PRIORITY_FIELD_ID` | Project field ID for Priority | ✅ field updates |
| `LANE_FIELD_ID` | Project field ID for Lane | ✅ lane updates |
| `STATUS_OPTIONS_JSON` | JSON map status names → option IDs | ✅ field updates |
| `SIZE_OPTIONS_JSON` | JSON map size names → option IDs | ✅ field updates |
| `PRIORITY_OPTIONS_JSON` | JSON map priority names → option IDs | ✅ field updates |
| `LANE_OPTIONS_JSON` | JSON map lane names → option IDs | ✅ lane updates |

## Related

- [Taxonomy SSoT](../../references/issue-taxonomy.md) — field set, cross-repo behavior, plugin contracts, anti-patterns

$ARGUMENTS
