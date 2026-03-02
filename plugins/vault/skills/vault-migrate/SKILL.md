---
name: vault-migrate
description: 'Migrate data from 2ndBrain memory.db to Roxabi vault — non-destructive copy with schema mapping. Triggers: "vault-migrate" | "migrate vault" | "migrate to vault" | "import to vault" | "vault import".'
version: 0.1.0
allowed-tools: Bash, Read
---

# Vault Migrate

Migrate existing data from a 2ndBrain memory.db into the Roxabi vault. Non-destructive — the original database is never modified.

Let:
  V   := vault home (~/.roxabi-vault/ or $ROXABI_VAULT_HOME)
  DB  := V/vault.db
  SRC := source memory.db (auto-detected or user-specified)

## Phase 1 — Detect Source

Look for existing memory.db files:

```bash
echo "=== Searching for memory.db ==="
# Common locations
for loc in \
    "$HOME/.2ndbrain/memory.db" \
    "$HOME/.secondbrain/memory.db" \
    "$HOME/.config/2ndbrain/memory.db" \
    "$HOME/memory.db"; do
    test -f "$loc" && echo "FOUND: $loc"
done
```

If no memory.db found, ask the user for the path using AskUserQuestion. If user has no memory.db, report "Nothing to migrate" and stop.

## Phase 2 — Inspect Source Schema

Examine the source database to understand its structure:

```bash
python3 -c "
import sqlite3
conn = sqlite3.connect('$SRC')
import re
tables = conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()
print('Tables:', [t[0] for t in tables])
for t in tables:
    name = t[0]
    if not re.match(r'^[a-zA-Z_]\w*$', name):
        print(f'  {name}: SKIPPED (unsafe name)')
        continue
    info = conn.execute(f'PRAGMA table_info(\"{name}\")').fetchall()
    count = conn.execute(f'SELECT COUNT(*) FROM \"{name}\"').fetchone()[0]
    print(f'  {name}: {count} rows')
    for col in info:
        print(f'    {col[1]} ({col[2]})')
conn.close()
"
```

Report the source schema and entry count to the user.

## Phase 3 — Confirm Migration

Use AskUserQuestion to confirm:
- Source: path to memory.db
- Entries found: N
- Destination: vault.db
- Mode: copy (original untouched)

Options:
- **Migrate all** — copy everything
- **Preview first** — show sample entries before migrating
- **Cancel** — abort

## Phase 4 — Map and Copy

Map the source schema to vault entries. Common 2ndBrain fields:

| Source field | Vault field |
|-------------|-------------|
| title / name | title |
| content / body / text | content |
| category / tag | category |
| type / kind | type |
| created / created_at / timestamp | created_at |
| metadata / extra | metadata |

Run the migration:

```bash
python3 -c "
import sqlite3, json
from datetime import datetime

src = sqlite3.connect('$SRC')
src.row_factory = sqlite3.Row

# Auto-detect source table and columns
import re
tables = [t[0] for t in src.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").fetchall()]
# Validate table names (defense against crafted databases)
tables = [t for t in tables if re.match(r'^[a-zA-Z_]\w*$', t)]
# Pick the main data table (largest row count)
main_table = max(tables, key=lambda t: src.execute(f'SELECT COUNT(*) FROM \"{t}\"').fetchone()[0])
cols = [c[1] for c in src.execute(f'PRAGMA table_info(\"{main_table}\")').fetchall()]

# Connect to vault
import sys
sys.path.insert(0, '\$PLUGIN_DIR')
from _lib.memory.db import VaultDB
db = VaultDB()
db.connect()

# Map columns
rows = src.execute(f'SELECT * FROM \"{main_table}\"').fetchall()
migrated = 0
for row in rows:
    row_dict = dict(row)
    title = row_dict.get('title') or row_dict.get('name') or 'Untitled'
    content = row_dict.get('content') or row_dict.get('body') or row_dict.get('text') or ''
    category = row_dict.get('category') or row_dict.get('tag') or 'imported'
    entry_type = row_dict.get('type') or row_dict.get('kind') or 'note'
    created = row_dict.get('created_at') or row_dict.get('created') or row_dict.get('timestamp') or datetime.now().isoformat()

    # Preserve original data as metadata
    metadata = {'source': 'memory.db', 'original_table': main_table}
    if 'metadata' in row_dict and row_dict['metadata']:
        try:
            metadata.update(json.loads(row_dict['metadata']))
        except (json.JSONDecodeError, TypeError):
            metadata['original_metadata'] = str(row_dict['metadata'])

    db.conn.execute(
        'INSERT INTO entries (category, type, title, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        (category, entry_type, title, content, json.dumps(metadata), created)
    )
    migrated += 1

db.conn.commit()
print(f'Migrated {migrated} entries')
db.close()
src.close()
"
```

## Phase 5 — Verify

Check the migration results:

```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
python3 "$PLUGIN_DIR/scripts/manage_vault.py" stats
```

## Phase 6 — Report

```
Vault Migration Complete
  Source:     <path to memory.db>
  Entries:    <N> migrated
  Original:  untouched
  Vault:     <total entries> entries
  Status:    complete
```

$ARGUMENTS
