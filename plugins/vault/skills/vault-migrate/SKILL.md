---
name: vault-migrate
description: 'Migrate data from 2ndBrain memory.db + knowledge/ files to Roxabi Vault (v2: fastembed embeddings, namespace, dedup, file migration). Triggers: "vault-migrate" | "migrate vault" | "migrate to vault" | "import to vault" | "vault import".'
version: 0.2.0
allowed-tools: Bash, Read
---

# Vault Migrate

Migrate all 2ndBrain knowledge into Roxabi Vault using the v2 schema (fastembed embeddings,
namespace support, field dedup, file migration). Non-destructive — the source database and
files are never modified.

Let:
  V            := vault home (~/.roxabi-vault/ or $ROXABI_VAULT_HOME)
  DB           := V/vault.db
  SRC          := source memory.db (auto-detected or user-specified)
  KNOWLEDGE    := source knowledge/ directory (same folder as memory.db)
  PLUGIN_DIR   := directory containing this SKILL.md (two levels up from scripts/)
  SCRIPT       := PLUGIN_DIR/scripts/migrate_2ndbrain.py

## Phase 1 — Detect Source

Check that the source database exists at the default location:

```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$PLUGIN_DIR/scripts/migrate_2ndbrain.py"
DEFAULT_SRC="$HOME/projects/2ndBrain/knowledge/memory.db"

if [ -f "$DEFAULT_SRC" ]; then
    echo "Found: $DEFAULT_SRC"
else
    echo "Not found at default path: $DEFAULT_SRC"
    echo "Use --source to specify a custom path."
fi
```

If the source is not found at the default path, ask the user for the correct path using
AskUserQuestion. If the user has no memory.db, report "Nothing to migrate" and stop.

## Phase 2 — Confirm Migration

Show the user what will be migrated before proceeding:

```bash
python3 -c "
import sqlite3, json, sys
src = sys.argv[1]
conn = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
count = conn.execute('SELECT COUNT(*) FROM documents').fetchone()[0]
cats  = conn.execute('SELECT category, COUNT(*) FROM documents GROUP BY category').fetchall()
conn.close()
print(json.dumps({'entries': count, 'by_category': dict(cats)}, indent=2))
" "$DEFAULT_SRC"
```

Use AskUserQuestion to confirm:
- Source: path to memory.db and knowledge/ directory
- Entries found: N
- Destination: vault.db
- Mode: copy — original files and database are never modified

Options:
- **Migrate** — run the full migration
- **Dry-run** — validate mappings without writing to vault
- **Cancel** — abort

## Phase 3 — Migrate DB Entries

Run `migrate_2ndbrain.py` with (or without) `--dry-run`:

```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$PLUGIN_DIR/scripts/migrate_2ndbrain.py"

# Full migration (standard)
python3 "$SCRIPT" \
    --source "$HOME/projects/2ndBrain/knowledge/memory.db" \
    --knowledge-dir "$HOME/projects/2ndBrain/knowledge"

# Dry-run (no writes)
# python3 "$SCRIPT" --dry-run
```

Progress and warnings are written to stderr. The script:
1. Opens memory.db read-only
2. Reads all rows from the documents table
3. Maps fields (summary + long_summary → content, source_date → event_date via raw UPDATE)
4. Checks dedup via `json_extract(metadata, '$.source_id')` — skips already-migrated entries
5. Calls `MemoryDB.save_entry()` with namespace='vault'
6. Computes a 384-dim fastembed embedding and stores it via raw UPDATE
7. Logs broken file references (DB row migrated, file copy skipped)

## Phase 4 — Migrate Files

The script also handles file migration automatically in the same run:
- Scans all markdown files under knowledge/
- Copies each file to the corresponding `~/.roxabi-vault/` subdirectory
- Creates vault entries for disk-only files (no DB row), auto-categorized by directory

Directory → category/type mapping for disk-only files:

| Directory        | category  | type       |
|-----------------|-----------|------------|
| analyses/        | knowledge | analysis   |
| content/ (linkedin in filename) | content | linkedin |
| content/ (other) | content   | article    |
| cv/              | content   | cv-base    |
| cv/adapted/      | content   | cv-adapted |
| ideas/           | idea      | idea       |
| learnings/       | knowledge | learning   |
| (root)           | knowledge | note       |

## Phase 5 — Verify

The script runs verification automatically and includes results in the JSON report:
- Count check: vault entry counts vs source document counts by category
- FTS5 smoke tests: 5 queries (twitter, github, linkedin, mmorpg, "Product Manager") — each must return ≥1 result

To inspect the vault after migration:

```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
python3 "$PLUGIN_DIR/scripts/manage_vault.py" stats
```

## Phase 6 — Report

The script outputs a JSON report to stdout:

```json
{
  "migration": {
    "db_entries": { "new": 465, "skipped": 0, "errors": 0 },
    "files":      { "copied": 59, "new_entries": 16, "errors": 0 },
    "broken_refs": ["path/to/missing-file.md"]
  },
  "verification": {
    "counts": {
      "source_count": 465,
      "vault_count":  483,
      "by_category": { "source": {}, "vault": {} }
    },
    "fts_smoke_tests": [
      { "query": "twitter", "desc": "knowledge/twitter entries", "hits": 12, "pass": true }
    ],
    "all_fts_pass": true
  },
  "idempotent": false
}
```

Present the report to the user highlighting:
- Total entries migrated (new) and skipped (dedup)
- Files copied and new entries created
- Any broken file references (warnings only — not errors)
- FTS5 smoke test pass/fail summary
- Whether this was an idempotent re-run (idempotent: true means 0 new entries)

If `all_fts_pass` is false, note which queries returned 0 results so the user can investigate.

$ARGUMENTS
