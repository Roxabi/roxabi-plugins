# cocoindex-code

AST-based semantic code search via the [`ccc`](https://github.com/cocoindex-io/cocoindex-code) CLI, packaged as a Claude Code plugin.

## What it does

Wraps the upstream `ccc` CLI so coding agents can:

- Run semantic search across the current codebase (`ccc search "user authentication"`).
- Auto-init and auto-index on first use (no MCP, no daemon to wire up manually).
- Refresh the index on demand (`ccc index`, `ccc search --refresh`).

## Install

```bash
# 1. Install the CLI (one-time, global)
pipx install 'cocoindex-code[full]'

# 2. Install this plugin from the Roxabi marketplace
/plugin marketplace add Roxabi/roxabi-plugins
/plugin install cocoindex-code@roxabi-marketplace
```

The skill triggers automatically when the agent needs code search; you can also nudge it explicitly with `search the codebase X` or `/cocoindex-code:ccc`.

## Why mirror upstream?

Upstream ships its own [Claude Code marketplace](https://github.com/cocoindex-io/cocoindex-code) (PR pending). This mirror exists so Roxabi users get the skill from the standard `Roxabi/roxabi-plugins` marketplace they already trust, without adding a second marketplace source.

When upstream merges its own marketplace manifest, you can switch to it directly with `/plugin marketplace add cocoindex-io/cocoindex-code`. Both flows install the same skill.

## Attribution

Skill content (`skills/ccc/SKILL.md`, `references/management.md`, `references/settings.md`) is mirrored verbatim from [`cocoindex-io/cocoindex-code`](https://github.com/cocoindex-io/cocoindex-code) under the **Apache License 2.0**. Copyright remains with the CocoIndex authors. See [LICENSE](https://github.com/cocoindex-io/cocoindex-code/blob/main/LICENSE) upstream.

The `ccc` binary itself is **not** vendored — it is installed separately via `pipx`/`uv tool` and called from the skill.
