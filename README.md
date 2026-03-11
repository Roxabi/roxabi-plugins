# Roxabi-plugins

![License](https://img.shields.io/badge/license-MIT-22c55e)
![Bun](https://img.shields.io/badge/Bun-runtime-FBF0DF?logo=bun&logoColor=black)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugins-CC785C)

Open-source Claude Code plugins by [Roxabi](https://github.com/Roxabi). Context engineering tools for teams using Claude Code.

## Plugins

| Plugin | Description |
|--------|-------------|
| [dev-core](plugins/dev-core/README.md) | Full development workflow — frame, shape, plan, implement, review, ship. 27 skills, 9 agents, safety hooks. Project-agnostic via stack.yml |
| [compress](plugins/compress/README.md) | Rewrite agent/skill definitions using compact math/logic notation to reduce token usage |
| [1b1](plugins/1b1/README.md) | Walk through a list of items one by one — brief, decide, execute, repeat |
| [web-intel](plugins/web-intel/README.md) | Multi-platform URL scraper + 6 analysis skills (scrape, summarize, analyze, roast, benchmark, adapt) |
| [linkedin-post-generator](plugins/linkedin-post-generator/README.md) | Generate engaging LinkedIn posts with best practices and visual identity |
| [image-prompt-generator](plugins/image-prompt-generator/README.md) | Generate AI image prompts with visual identity and style consistency |
| [cv](plugins/cv/README.md) | Generate and adapt CVs from structured data |
| [get-invoice-details](plugins/get-invoice-details/README.md) | Extract and store invoice details from documents |
| [linkedin-apply](plugins/linkedin-apply/README.md) | Scrape and score LinkedIn job offers with LLM matching |
| [frontend-slides](plugins/frontend-slides/README.md) | Zero-dependency HTML presentations — 12 style presets, visual discovery, PPT conversion |
| [visual-explainer](plugins/visual-explainer/README.md) | Self-contained HTML pages with diagrams, visualizations, and data tables |
| [react-best-practices](plugins/react-best-practices/README.md) | React/Next.js performance optimization — 58 rules, 8 categories (Vercel Engineering) |
| [composition-patterns](plugins/composition-patterns/README.md) | React composition patterns — compound components, context providers (Vercel) |
| [web-design-guidelines](plugins/web-design-guidelines/README.md) | Review UI code for Web Interface Guidelines compliance (Vercel) |

## Data Storage

All data-producing plugins store user data in `~/.roxabi-vault/` (never in the repo). Override with `ROXABI_VAULT_HOME` environment variable. Vault functionality is provided by [roxabi-memory](https://github.com/Roxabi/roxabi-memory).

| Plugin | Data Location |
|--------|--------------|
| cv | `~/.roxabi-vault/cv/` |
| linkedin-post-generator | `~/.roxabi-vault/content/` (shared) |
| get-invoice-details | `~/.roxabi-vault/invoices/` |
| image-prompt-generator | `~/.roxabi-vault/config/`, `~/.roxabi-vault/image-prompts/` |
| linkedin-apply | `~/.roxabi-vault/linkedin-apply/` |

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
