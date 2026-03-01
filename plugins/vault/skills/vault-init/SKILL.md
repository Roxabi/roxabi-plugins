---
name: vault-init
description: 'Initialize the Roxabi vault — create ~/.roxabi-vault/ with SQLite+FTS5 database, subdirectories, and WAL mode. Triggers: "vault-init" | "init vault" | "setup vault" | "create vault" | "initialize vault".'
version: 0.1.0
allowed-tools: Bash, Read
---

# Vault Init

First-time setup for the Roxabi vault. Creates the vault home directory, subdirectories, and initializes the SQLite+FTS5 database.

Let:
  V  := vault home (~/.roxabi-vault/ or $ROXABI_VAULT_HOME)
  DB := V/vault.db

## Phase 1 — Check Existing

Check if vault already exists:

```bash
VAULT_HOME="${ROXABI_VAULT_HOME:-$HOME/.roxabi-vault}"
echo "Vault home: $VAULT_HOME"
test -f "$VAULT_HOME/vault.db" && echo "VAULT_EXISTS" || echo "VAULT_NEW"
```

If VAULT_EXISTS, report current state (run stats via manage_vault.py) and stop. Do not reinitialize an existing vault.

## Phase 2 — Create Directory Structure

Create V with 700 permissions and subdirectories:

```bash
VAULT_HOME="${ROXABI_VAULT_HOME:-$HOME/.roxabi-vault}"
mkdir -p "$VAULT_HOME" && chmod 700 "$VAULT_HOME"
mkdir -p "$VAULT_HOME/config"
mkdir -p "$VAULT_HOME/content"
mkdir -p "$VAULT_HOME/ideas"
mkdir -p "$VAULT_HOME/learnings"
mkdir -p "$VAULT_HOME/backup"
echo "Directories created"
ls -la "$VAULT_HOME/"
```

## Phase 3 — Initialize Database

Create vault.db with schema and FTS5 index:

```bash
VAULT_SCRIPT="$(find "$(dirname "$(dirname "$(readlink -f "$0")")")" -path "*/scripts/manage_vault.py" 2>/dev/null | head -1)"
python3 -c "
import sys
sys.path.insert(0, '$(dirname \"$VAULT_SCRIPT\")/..')
from _lib.memory.db import VaultDB
db = VaultDB()
db.connect()
db.create_tables()
print('Schema created')
print('WAL mode:', db.conn.execute('PRAGMA journal_mode').fetchone()[0])
db.close()
"
```

Alternatively, resolve the script path from the plugin directory where this SKILL.md resides:

```bash
PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
python3 -c "
import sys
sys.path.insert(0, '$PLUGIN_DIR')
from _lib.memory.db import VaultDB
db = VaultDB()
db.connect()
db.create_tables()
print('Schema created')
print('WAL mode:', db.conn.execute('PRAGMA journal_mode').fetchone()[0])
db.close()
"
```

## Phase 4 — Verify

Confirm the vault is healthy:

```bash
VAULT_HOME="${ROXABI_VAULT_HOME:-$HOME/.roxabi-vault}"
python3 -c "
import sqlite3, os
db_path = '$VAULT_HOME/vault.db'
conn = sqlite3.connect(db_path)
tables = conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()
print('Tables:', [t[0] for t in tables])
mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
print('Journal mode:', mode)
count = conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
print('Entries:', count)
size = os.path.getsize(db_path)
print('DB size:', size, 'bytes')
conn.close()
"
```

## Phase 5 — Report

```
Vault Initialized
  Location:    ~/.roxabi-vault/
  Database:    vault.db (SQLite + FTS5)
  WAL mode:    enabled
  Directories: config/, content/, ideas/, learnings/, backup/
  Status:      ready
```

$ARGUMENTS
