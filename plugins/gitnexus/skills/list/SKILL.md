---
name: gitnexus-list
argument-hint: ''
description: List all GitNexus-indexed repositories. Triggers: "list repos" | "gitnexus list" | "what repos are indexed" | "show indexed repos".
version: 0.1.0
allowed-tools: Bash
---

# GitNexus List

List all repositories registered in the GitNexus global registry.

## Entry

```
/gitnexus-list
```

## Step 1 — Run List

```bash
gitnexus list
```

## Step 2 — Parse JSON Output

```json
{
  "repos": [
    {
      "name": "my-project",
      "path": "/home/user/projects/my-project",
      "indexed_at": "2024-01-15T10:30:00Z",
      "last_commit": "abc123",
      "stats": {
        "symbols": 1234,
        "relationships": 5678
      }
    }
  ]
}
```

## Step 3 — Present Results

| Repo | Path | Symbols | Relationships | Last Indexed |
|------|------|---------|---------------|--------------|
| my-project | ~/projects/my-project | 1,234 | 5,678 | 2024-01-15 |
| lyra | ~/projects/lyra | 2,456 | 12,345 | 2024-01-14 |

**No repos indexed** → suggest: `/gitnexus-analyze` in a project directory.

$ARGUMENTS
