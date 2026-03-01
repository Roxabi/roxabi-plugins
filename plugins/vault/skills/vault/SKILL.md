---
name: vault
description: 'Unified data vault — add, search, list, get, delete, stats, export entries in a SQLite+FTS5 knowledge base. Triggers: "vault" | "vault add" | "vault search" | "vault list" | "vault stats" | "vault export" | "vault delete" | "search vault" | "add to vault".'
version: 0.1.0
allowed-tools: Read, Bash, Glob, AskUserQuestion
---

# Vault

Manage the Roxabi vault — a local SQLite+FTS5 knowledge base at `~/.roxabi-vault/vault.db`.

Let:
  V  := vault home (~/.roxabi-vault/ or $ROXABI_VAULT_HOME)
  DB := V/vault.db
  S  := plugins/vault/scripts/manage_vault.py

## Operations

All operations go through `manage_vault.py`. Output is always JSON.

### Phase 1 — Parse Command

Determine the operation from user input:

| Operation | When |
|-----------|------|
| **add** | User wants to store knowledge, note, idea, learning |
| **search** | User wants to find entries by keyword or phrase |
| **list** | User wants to browse entries, optionally filtered |
| **get** | User wants full details of a specific entry by ID |
| **delete** | User wants to remove an entry by ID |
| **stats** | User wants vault statistics |
| **export** | User wants to export entries as JSON |

### Phase 2 — Check Vault

Verify vault is initialized:

```bash
python3 S stats 2>&1 || echo "VAULT_NOT_READY"
```

If vault is not ready, tell the user to run `vault-init` first. Do not attempt to create the database.

### Phase 3 — Execute

Resolve the plugin script path relative to this skill file:

```bash
VAULT_SCRIPT="$(dirname "$(dirname "$(dirname "$(readlink -f "$0")")")")/scripts/manage_vault.py"
```

Run the appropriate command:

**Add:**
```bash
python3 S add --category "<category>" --type "<type>" --title "<title>" --content "<content>"
```

Categories: `content`, `ideas`, `learnings`, `notes`, `references`, or user-specified.
Types: `note`, `idea`, `learning`, `snippet`, `reference`, `bookmark`, or user-specified.

If the user does not specify category/type, infer from context:
- Ideas, brainstorms -> category=ideas, type=idea
- Code snippets, patterns -> category=content, type=snippet
- Lessons, insights -> category=learnings, type=learning
- General notes -> category=notes, type=note
- Links, resources -> category=references, type=bookmark

**Search:**
```bash
python3 S search "<query>" --limit <N>
```

Present results in a readable table with id, title, category, and a content preview.

**List:**
```bash
python3 S list --category "<category>" --type "<type>" --limit <N>
```

All filters are optional. Present results as a table.

**Get:**
```bash
python3 S get <id>
```

Display the full entry with all fields.

**Delete:**
```bash
python3 S delete <id>
```

Before deleting, get the entry and show it to the user. Ask for confirmation using AskUserQuestion.

**Stats:**
```bash
python3 S stats
```

Format the JSON output as a readable summary.

**Export:**
```bash
python3 S export --category "<category>" --type "<type>" -o "<path>"
```

If no output path given, display the JSON. If path given, confirm the export location.

### Phase 4 — Report

Display the operation result. For search results, format as a readable table:

```
ID  | Category  | Type     | Title                  | Created
----|-----------|----------|------------------------|-------------------
1   | learnings | learning | SQLite WAL advantages  | 2024-01-15 10:30
```

For add operations, confirm with the entry ID. For stats, show a formatted summary.

$ARGUMENTS
