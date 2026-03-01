# Vault

A Claude Code plugin that gives you a local, searchable knowledge base. Store ideas, learnings, code snippets, and notes in a SQLite database with full-text search — all from inside Claude Code.

## What it does

Vault provides a persistent knowledge store at `~/.roxabi-vault/vault.db`. It uses SQLite with FTS5 for fast full-text search across all your entries. Other Roxabi plugins can also index their content into the vault, making it a central hub for everything you save.

The plugin includes three skills:

- **vault** — the main interface for adding, searching, listing, getting, deleting, and exporting entries
- **vault-init** — first-time setup that creates the database and directory structure
- **vault-migrate** — imports data from an existing 2ndBrain memory.db (non-destructive)

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install vault
```

## Usage

### Initialize the vault

Run this once to create the database:

- `vault-init`
- `init vault`
- `setup vault`

### Manage entries

Use any of these trigger phrases:

- `vault add` — store a new entry (idea, note, learning, snippet, etc.)
- `vault search <query>` — full-text search across all entries
- `vault list` — browse entries, filter by category or type
- `vault get <id>` — view full details of an entry
- `vault delete <id>` — remove an entry (with confirmation)
- `vault stats` — see how many entries you have, broken down by category and type
- `vault export` — export entries as JSON, optionally filtered

### Migrate from 2ndBrain

If you have an existing memory.db:

- `vault-migrate`
- `migrate to vault`

The migration copies data without modifying the original database.

## Categories and types

Entries are organized by category and type. The defaults are:

| Category | Types | Use for |
|----------|-------|---------|
| content | snippet, reference | Code patterns, reusable fragments |
| ideas | idea | Brainstorms, feature ideas, design concepts |
| learnings | learning | Insights, lessons learned, debugging tips |
| notes | note | General notes, meeting summaries |
| references | bookmark | Links, resources, documentation pointers |

You can use any category and type you want — these are just conventions.

## How it works

### Storage

All data lives in `~/.roxabi-vault/` (override with `ROXABI_VAULT_HOME` environment variable):

```
~/.roxabi-vault/
  vault.db          # SQLite database with FTS5 index
  config/           # Plugin configuration files
  content/          # Content files (used by plugins)
  ideas/            # Ideas directory
  learnings/        # Learnings directory
  backup/           # Database backups
```

### Full-text search

Vault uses SQLite FTS5 with BM25 ranking for relevance-ordered search. The FTS index covers title, content, category, and type fields. Inserts, updates, and deletes are automatically kept in sync via triggers.

### WAL mode

The database runs in Write-Ahead Logging mode for better concurrent read performance and crash resilience.

### Cross-plugin indexing

Other plugins can index content into the vault using the `content_indexer.py` helper. This fails gracefully if the vault is not initialized, so plugins can call it unconditionally.

## License

MIT
