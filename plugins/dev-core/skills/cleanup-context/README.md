# cleanup-context

Audit and clean CLAUDE.md files, auto-memory, skill files, and agent rules. Resolves every finding — fix, promote, relocate, or delete.

## Usage

```
/R-cleanup-context                        → Audit all context areas
/R-cleanup-context --scope claude-md      → Only audit CLAUDE.md files
/R-cleanup-context --scope skills         → Only audit skill files
/R-cleanup-context --scope memory         → Only audit auto-memory
/R-cleanup-context --dry-run              → Show findings without applying fixes
```

## What it does

Targets the "rule accumulation decay" problem: as rules accumulate, contradictions and bloat silently degrade agent performance.

**Discovery** → finds all context files (CLAUDE.md imports, memory files, skill files, agent memory)

**Analysis** → identifies: contradictions, stale references, redundancies, bloat, orphaned memory entries

**Resolution** — each finding gets exactly one resolution:

| Resolution | When |
|-----------|------|
| Fix | Root cause is a bug or design flaw |
| Promote | Durable insight needed across multiple agents |
| Relocate | Knowledge is in the wrong scope |
| Delete | Ephemeral, stale, or already covered — and no durable lesson worth promoting |

Always shows exact diffs before applying. Never deletes entire files.

A memory entry whose tracked `#NNNN` refs have all closed is a *candidate*, not a deletion: the tracker is finished, the lesson in it may not be. Refs that can't be resolved (no `gh`, expired token, rate limit) count as open, so an outage can never propose a purge. Deleting or moving a memory file sweeps its `[[wikilink]]` backlinks in the same pass, before the removal.

## When to run

After shipping a feature · after branch cleanup · when memory files grow large · periodically after N completed issues

## Triggers

`"cleanup context"` | `"context audit"` | `"clean memory"` | `"consolidate rules"` | `"spa day"`
