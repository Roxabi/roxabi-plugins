# Memory Audit

A Claude Code plugin that keeps your auto-memory clean. It treats memory as an inbox, not a knowledge base — every entry gets reviewed and resolved so nothing piles up.

## What it does

Claude Code automatically saves notes to memory files as you work. Over time, these files fill up with stale references, duplicate insights, and temporary context that no longer matters. Memory Audit drains them back to zero.

When you run an audit, the plugin:

1. **Inventories** all memory sources — project memory (`MEMORY.md`, topic files) and agent memory files
2. **Scans your project** to find the right permanent homes for useful knowledge (CLAUDE.md, agent definitions, domain docs, etc.)
3. **Classifies every entry** into one of four resolutions:
   - **Fix** — the entry describes a bug or workaround; fix the root cause, then delete the entry
   - **Promote** — the entry is a durable insight that belongs in permanent docs; move it there
   - **Relocate** — the entry is agent-specific or domain-specific; move it to the right scoped file
   - **Delete** — the entry is stale, ephemeral, or already covered elsewhere
4. **Presents a plan** and asks for your approval before making changes
5. **Executes** the approved resolutions — moving content, fixing code, deleting entries
6. **Logs the audit** to an append-only log so you can track what was resolved and when
7. **Detects recurrences** — if the same type of entry keeps coming back, it flags a systemic issue that needs a deeper fix

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install roxabi-plugins
```

### From a local clone

```bash
git clone https://github.com/Roxabi/roxabi-plugins.git
claude plugin install /path/to/roxabi-plugins
```

## Usage

Run the audit with any of these phrases in Claude Code:

- `memory-audit`
- `audit memory`
- `clean memory`
- `prune memory`
- `drain memory`

The plugin walks you through each phase interactively. You approve the resolution plan before any changes are made.

## When to run

- After shipping a feature (temporary context is likely stale)
- After cleaning up branches (worktree references are likely stale)
- Whenever memory files have more than a handful of entries
- As part of regular project maintenance

## How it works

### Placement hierarchy

The plugin auto-discovers where knowledge should live in your project. It picks the narrowest scope that covers all consumers:

| Scope | Target |
|-------|--------|
| All agents need it | `CLAUDE.md` (root) |
| Agent coordination | `AGENTS.md` |
| One domain (monorepo) | `<domain>/CLAUDE.md` |
| One agent | `.claude/agents/<agent>.md` |
| One skill | `.claude/skills/<skill>/SKILL.md` |
| Human-facing docs | `docs/` directory |

### Recurrence detection

The plugin keeps an append-only audit log at `.claude/memory-audit-log.md`. Before resolving entries, it checks whether similar entries were resolved in past audits:

- **1st occurrence** — resolved normally
- **2nd occurrence** — flagged as a fix that didn't stick, with investigation prompts
- **3rd+ occurrence** — flagged as a systemic gap that needs a root cause fix

### Audit log

Every audit appends a summary to the log with the entry name, source, resolution, target, and recurrence count. This gives you a history of how memory was managed over time.

## License

MIT
