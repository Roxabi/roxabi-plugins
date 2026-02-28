# Roxabi-plugins

Open-source Claude Code plugins by [Roxabi](https://github.com/MickaelV0). Context engineering tools for teams using Claude Code.

## Plugins

| Plugin | Description |
|--------|-------------|
| [memory-audit](plugins/memory-audit/README.md) | Drain auto-memory to zero — every entry gets resolved (fix/promote/relocate/delete) with audit logging and recurrence detection |
| [compress](plugins/compress/README.md) | Rewrite agent/skill definitions using compact math/logic notation to reduce token usage |
| [1b1](plugins/1b1/README.md) | Walk through a list of items one by one — brief, decide, execute, repeat |

## Install

### Add the marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
```

### Install a specific plugin

```bash
claude plugin install memory-audit
```

You only install what you need. Each plugin is independent.

## License

MIT
