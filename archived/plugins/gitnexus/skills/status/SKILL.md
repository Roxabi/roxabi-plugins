---
name: gitnexus-status
argument-hint: ''
description: Check GitNexus index status for current repo — freshness, symbol count, staleness. Triggers: "check index" | "gitnexus status" | "is graph stale" | "index status".
version: 0.1.0
allowed-tools: Bash
---

# GitNexus Status

Check if the current repository is indexed and whether the index is stale (behind HEAD).

## Entry

```
/gitnexus-status
```

## Step 1 — Run Status

```bash
gitnexus status
```

## Step 2 — Parse JSON Output

```json
{
  "indexed": true,
  "repo": "my-project",
  "path": "/home/user/projects/my-project",
  "last_commit": "abc123",
  "head_commit": "def456",
  "stale": true,
  "stats": {
    "symbols": 1234,
    "relationships": 5678,
    "processes": 42,
    "embeddings": 0
  }
}
```

## Step 3 — Present Results

| | |
|--|--|
| **Repo** | my-project |
| **Indexed** | ✅ Yes |
| **Stale** | ⚠️ Yes (3 commits behind) |
| **Symbols** | 1,234 |
| **Relationships** | 5,678 |
| **Processes** | 42 |
| **Embeddings** | No |

**Stale index detected** → recommend: `/gitnexus-analyze` to refresh.

**Not indexed** → recommend: `/gitnexus-analyze` to create index.

## Edge Cases

- `indexed: false` → repo not indexed, suggest `/gitnexus-analyze`
- `stale: true` → graph is behind HEAD, warn user
- Outside git repo → error message, suggest cd to repo

$ARGUMENTS
