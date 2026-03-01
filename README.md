# Roxabi-plugins

Open-source Claude Code plugins by [Roxabi](https://github.com/Roxabi). Context engineering tools for teams using Claude Code.

## Plugins

| Plugin | Description |
|--------|-------------|
| [dev-core](plugins/dev-core/README.md) | Full development workflow — frame, shape, plan, implement, review, ship. 19 skills, 9 agents, safety hooks |
| [memory-audit](plugins/memory-audit/README.md) | Drain auto-memory to zero — every entry gets resolved (fix/promote/relocate/delete) with audit logging and recurrence detection |
| [compress](plugins/compress/README.md) | Rewrite agent/skill definitions using compact math/logic notation to reduce token usage |
| [1b1](plugins/1b1/README.md) | Walk through a list of items one by one — brief, decide, execute, repeat |
| [web-intel](plugins/web-intel/README.md) | Multi-platform URL scraper + 6 analysis skills (scrape, summarize, analyze, roast, benchmark, adapt) |
| [voice-me](plugins/voice-me/README.md) | VoiceMe assistant — author TTS scripts, generate speech (4 engines incl. CUDA-accelerated Qwen-Fast), clone voices, chunked output, transcribe audio |
| [linkedin-post-generator](plugins/linkedin-post-generator/README.md) | Generate engaging LinkedIn posts with best practices and visual identity |
| [image-prompt-generator](plugins/image-prompt-generator/README.md) | Generate AI image prompts with visual identity and style consistency |
| [vault](plugins/vault/README.md) | Unified data vault — SQLite+FTS5 index, CRUD, search across all Roxabi plugins |
| [cv](plugins/cv/README.md) | Generate and adapt CVs from structured data |
| [get-invoice-details](plugins/get-invoice-details/README.md) | Extract and store invoice details from documents |

## Data Storage

All data-producing plugins store user data in `~/.roxabi-vault/` (never in the repo). Override with `ROXABI_VAULT_HOME` environment variable.

| Plugin | Data Location | Vault Integration |
|--------|--------------|-------------------|
| vault | `~/.roxabi-vault/vault.db` + shared dirs | Core (required) |
| cv | `~/.roxabi-vault/cv/` | Optional — search by content |
| linkedin-post-generator | `~/.roxabi-vault/content/` (shared) | Optional — suggestions from vault |
| get-invoice-details | `~/.roxabi-vault/invoices/` | Optional — semantic search |
| image-prompt-generator | `~/.roxabi-vault/config/visual-charter.json` | N/A — works 100% standalone |

All plugins work without vault installed — files are saved, just not indexed.

## Install

### Add the marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
```

### Install a specific plugin

```bash
claude plugin install <plugin-name>
```

You only install what you need. Each plugin is independent.

## License

MIT
