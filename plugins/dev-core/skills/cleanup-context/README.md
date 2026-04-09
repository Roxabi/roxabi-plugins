# cleanup-context

Audit and clean CLAUDE.md files, auto-memory, skill files, and agent rules. Resolves every finding — fix, promote, relocate, or delete.

## Usage

```
/cleanup-context                        → Audit all context areas
/cleanup-context --scope claude-md      → Only audit CLAUDE.md files
/cleanup-context --scope skills         → Only audit skill files
/cleanup-context --scope memory         → Only audit auto-memory
/cleanup-context --dry-run              → Show findings without applying fixes
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
| Delete | Ephemeral, stale, or already covered |

Always shows exact diffs before applying. Never deletes entire files.

## When to run

After shipping a feature · after branch cleanup · when memory files grow large · periodically after N completed issues

## Triggers

`"cleanup context"` | `"context audit"` | `"clean memory"` | `"consolidate rules"` | `"spa day"`
