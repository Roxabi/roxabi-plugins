---
name: gitnexus-analyze
argument-hint: '[path] [--force] [--embeddings]'
description: Index a repository into a GitNexus knowledge graph. Triggers: "index repo" | "analyze codebase" | "gitnexus analyze" | "build knowledge graph" | "create graph index".
version: 0.1.0
allowed-tools: Bash, Read
---

# GitNexus Analyze

Index a repository into a knowledge graph — parses source files, builds call/dependency relationships, detects execution flows.

## Entry

```
/gitnexus-analyze [path]
/gitnexus-analyze --force        # Force full re-index
/gitnexus-analyze --embeddings   # Enable semantic search vectors
```

## Step 0 — Check Installation

```bash
which gitnexus || npm list -g gitnexus
```

¬found → → DP(B) install first: `npm install -g gitnexus`.

## Step 1 — Resolve Path

No path arg → use current working directory.

Path arg → resolve to absolute path.

¬git repo at path → → DP(B) path must be inside a git repository, or use `--skip-git` flag.

## Step 2 — Run Analysis

```bash
cd "$REPO_PATH" && gitnexus analyze $FLAGS
```

| Flag | Effect |
|------|--------|
| `--force` | Full re-index even if up to date |
| `--embeddings` | Enable vector embeddings (slower, better semantic search) |
| `--skip-git` | Index folder without `.git` directory |
| `--verbose` | Show skipped files and warnings |

## Step 3 — Parse Output

Read JSON output → extract:

| Field | Meaning |
|-------|---------|
| `stats.symbols` | Number of indexed symbols |
| `stats.relationships` | Number of relationships |
| `stats.processes` | Number of execution flows |
| `path` | Where `.gitnexus/` was created |

## Step 4 — Report

**Done:**
- Indexed `{N}` symbols, `{M}` relationships, `{P}` processes
- Graph stored at `.gitnexus/`
- Run `/gitnexus-query` to search, `/gitnexus-impact` before edits

## Error Handling

- "Not inside a git repository" → suggest `--skip-git` or change directory
- "No supported languages found" → list supported: TypeScript, JavaScript, Python, Go, Rust, Java, C++, Ruby, etc.
- "Out of memory" → large repo, suggest `--skip-git` or increase Node heap

$ARGUMENTS
