---
name: issues
argument-hint: [--digest | -D | --show <N> | --json | --tree | -T | --priority]
description: List GitHub issues — status, dependencies, backlog. Triggers: "list issues" | "show issues" | "backlog" | "what's blocked" | "what issues are open" | "show backlog" | "show the board" | "what are we working on" | "issue status" | "digest" | "roadmap" | "phase view" | "execution order" | "what should I work on".
version: 0.3.0
allowed-tools: Bash, Read
---

# Issues

Let: Φ := CLAUDE_PLUGIN_ROOT | Φ_i := bun ${CLAUDE_PLUGIN_ROOT}/skills/issues | ⊣ := Stop here

List open GitHub issues with Status, Size, Priority, dependency relationships.

## Instructions

**`--show <N>` ∈ $ARGUMENTS →**

Let N := issue number extracted from $ARGUMENTS (e.g. `--show 42` → N=42).

1. `Φ_i/show.ts N`
2. Output verbatim. ⊣ — ¬WIP, ¬recommendations

---

**`--tree` ∨ `-T` ∈ $ARGUMENTS →** Pass flag to fetch script (step 1). Output verbatim in code block. ¬reformat. ¬collapse. ¬truncate/summarize/omit rows. ¬post-process. ⊣ — ¬WIP.

---

**`--digest` ∨ `-D` ∈ $ARGUMENTS →**

1. `Φ_i/digest.ts` — outputs pre-rendered markdown + a `<!-- lanes:{…} -->` comment
2. Print the markdown section verbatim (table already rendered — ¬re-render).
3. Generate `## Execution order — N parallel lanes` using the `lanes` JSON comment:
   `[{n, bl:[blockerNums], sub:[subEpicNums]}]` — titles visible in table above.
   Group by dependency chain → lanes → phases. ⊣ — ¬trailing summary. ¬WIP.

---

**Default (CLI table):**

1. `Φ_i/list.ts`

2. Output verbatim in code block. ¬reformat. ¬truncate/summarize/omit rows.

3. Recommendations (≤3 lines): ✅ ∧ P0/P1 → prioritize | ¬Size ∨ ¬Priority → suggest `/issue-triage` | many blocked → identify critical blocker

4. WIP:
   ```bash
   git worktree list
   git branch --list | grep -v -E '^\*?\s*(main|master)$'
   gh pr list --state open --json number,title,headRefName,isDraft,labels
   ```
   Present: worktrees ¬main; issue-related branches; PRs: title + PR# + status, branch → `└`. Status: `DRAFT` if draft | `REVIEWED` if "reviewed" label ∃ | else `REVIEW`

## Options

| Flag | Description |
|------|-------------|
| `--digest` / `-D` | Epic progress + parallel execution order digest |
| `--show <N>` | Full details for issue #N — body, sub-issues, blockers, comments |
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

Dep view only. Modify → `/issue-triage`.

## Configuration

`GITHUB_REPO` ← git remote (auto-detected).

## Related

- [Taxonomy SSoT](../../references/issue-taxonomy.md) — GraphQL fetch contract, field/Issue-Type reader conventions

$ARGUMENTS
