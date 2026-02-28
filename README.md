# Roxabi-plugins

Open-source Claude Code plugins by [Roxabi](https://github.com/MickaelV0). Context engineering tools for teams using Claude Code.

## Plugins

| Plugin | Description |
|--------|-------------|
| [dev-core](plugins/dev-core/README.md) | Full development workflow — frame, shape, plan, implement, review, ship. 17 skills, 9 agents, safety hooks |
| [memory-audit](plugins/memory-audit/README.md) | Drain auto-memory to zero — every entry gets resolved (fix/promote/relocate/delete) with audit logging and recurrence detection |
| [compress](plugins/compress/README.md) | Rewrite agent/skill definitions using compact math/logic notation to reduce token usage |
| [1b1](plugins/1b1/README.md) | Walk through a list of items one by one — brief, decide, execute, repeat |
| [web-intel](plugins/web-intel/README.md) | Multi-platform URL scraper + 6 analysis skills (scrape, summarize, analyze, roast, benchmark, adapt) |

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
