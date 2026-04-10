# GitNexus Plugin

CLI-only integration with [GitNexus](https://github.com/abhigyanpatwari/GitNexus) — a zero-server code intelligence engine that builds knowledge graphs from your codebase.

## Why CLI Instead of MCP?

| Approach | Token Overhead | Setup |
|----------|----------------|-------|
| **MCP** (official) | High — full graph context loaded per query | Requires MCP server config |
| **CLI** (this plugin) | Minimal — only command output parsed | `npm install -g gitnexus` |

The MCP server loads the entire knowledge graph into context, burning tokens on every query. This plugin uses CLI commands instead — only the JSON output hits your context window.

**Use CLI when:** you want lightweight queries without token bloat.
**Use MCP when:** you need `detect_changes`, `rename`, or API route analysis.

## Prerequisites

**GitNexus CLI must be installed:**

```bash
npm install -g gitnexus
```

All skills check for the CLI and prompt to install if missing.

## Features

| Skill | CLI Command | Purpose |
|-------|-------------|---------|
| `analyze` | `gitnexus analyze` | Index a repository into a knowledge graph |
| `query` | `gitnexus query` | Search the graph for execution flows |
| `context` | `gitnexus context` | 360° view of a symbol (callers, callees, processes) |
| `impact` | `gitnexus impact` | Blast radius analysis before edits |
| `status` | `gitnexus status` | Check index freshness |
| `list` | `gitnexus list` | List all indexed repositories |

## Installation

### 1. Install GitNexus CLI

```bash
npm install -g gitnexus
```

### 2. Install the plugin

```bash
claude plugin install gitnexus
```

Or add to your project via the Roxabi marketplace.

## Quick Start

```bash
# Index a repository (run from repo root)
cd ~/projects/my-project
gitnexus analyze

# Check what you indexed
gitnexus status

# Search for execution flows
gitnexus query "authentication"

# See what breaks if you change a function
gitnexus impact validateUser --direction upstream

# Get full context on a symbol
gitnexus context AuthService
```

## Output Format

All commands output JSON (default), which Claude Code can parse directly:

```bash
gitnexus impact validateUser
```

```json
{
  "target": "validateUser",
  "direction": "upstream",
  "callers": [
    {"name": "loginHandler", "file": "src/auth/login.ts", "line": 42, "confidence": 1.0}
  ],
  "risk_level": "HIGH",
  "affected_processes": ["LoginFlow", "TokenRefresh"]
}
```

## Feature Parity

| Capability | CLI (this plugin) | MCP (official) |
|------------|-------------------|----------------|
| Query graph | ✅ | ✅ |
| Impact analysis | ✅ | ✅ |
| Symbol context | ✅ | ✅ |
| Cypher queries | ✅ | ✅ |
| Detect changes | ❌ | ✅ |
| Safe rename | ❌ | ✅ |
| API route analysis | ❌ | ✅ |

CLI covers ~70% of use cases. If you need `detect_changes`, `rename`, or API tools, run `gitnexus setup` to enable MCP — but expect higher token usage.

## Graph Storage

- Indexed graphs stored in `.gitnexus/` at repo root
- Global registry at `~/.gitnexus/registry.json`
- Re-run `gitnexus analyze` after significant code changes to refresh

## Skills

### /gitnexus-analyze

Index a repository into the knowledge graph.

```bash
/gitnexus-analyze [path]
/gitnexus-analyze --force        # Force re-index
/gitnexus-analyze --embeddings   # Enable semantic search
```

### /gitnexus-query

Search for execution flows related to a concept.

```bash
/gitnexus-query "authentication flow"
/gitnexus-query "error handling" --limit 10
```

### /gitnexus-context

Get 360° view of a symbol: callers, callees, processes it participates in.

```bash
/gitnexus-context validateUser
/gitnexus-context AuthService --file src/services/auth.ts
```

### /gitnexus-impact

Blast radius analysis: what breaks if you change a symbol.

```bash
/gitnexus-impact validateUser
/gitnexus-impact AuthService --direction downstream
/gitnexus-impact processOrder --depth 2
```

### /gitnexus-status

Check if the current repo is indexed and if the index is stale.

```bash
/gitnexus-status
```

### /gitnexus-list

List all indexed repositories.

```bash
/gitnexus-list
```

## License

MIT
