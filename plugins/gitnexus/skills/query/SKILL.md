---
name: gitnexus-query
argument-hint: '<search_query> [--limit N] [--content]'
description: Search the knowledge graph for execution flows related to a concept. Triggers: "search graph" | "find execution flow" | "gitnexus query" | "how does X work" | "find code related to".
version: 0.1.0
allowed-tools: Bash, Read
---

# GitNexus Query

Search the knowledge graph for execution flows and symbols related to a concept. Returns processes (call chains) ranked by relevance.

## Entry

```
/gitnexus-query "authentication flow"
/gitnexus-query "error handling" --limit 10
/gitnexus-query "database connection" --content  # include source code
```

¬query → → DP(B) provide a search term.

## Step 0 — Pre-flight

```bash
gitnexus status
```

¬indexed → → DP(B) run `/gitnexus-analyze` first.

Index stale → warn user, suggest re-indexing.

## Step 1 — Run Query

```bash
gitnexus query "$QUERY" $FLAGS
```

| Flag | Effect |
|------|--------|
| `--limit N` | Max processes to return (default: 5) |
| `--content` | Include full symbol source code |
| `--context "text"` | Task context for better ranking |
| `--goal "text"` | What you want to find |
| `--repo <name>` | Target specific repo if multiple indexed |

## Step 2 — Parse JSON Output

```json
{
  "processes": [
    {
      "name": "LoginFlow",
      "relevance": 0.95,
      "symbols": ["loginHandler", "validateUser", "createSession"]
    }
  ],
  "process_symbols": [...],
  "definitions": [...]
}
```

## Step 3 — Present Results

**Processes (execution flows):**

| Process | Relevance | Key Symbols |
|---------|-----------|-------------|
| LoginFlow | 0.95 | loginHandler, validateUser, createSession |
| TokenRefresh | 0.78 | refreshToken, verifyToken |

**Standalone definitions:** types/interfaces not in any process.

## Step 4 — Follow-up

- Want full symbol context → `/gitnexus-context <symbol>`
- Want blast radius → `/gitnexus-impact <symbol>`
- Want full process trace → `gitnexus://repo/{name}/process/{processName}` (requires MCP)

$ARGUMENTS
