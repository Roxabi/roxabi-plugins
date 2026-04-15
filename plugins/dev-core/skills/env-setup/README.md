# env-setup

Set up the local development environment — stack.yml, CLAUDE.md Critical Rules, docs scaffolding, VS Code MDX, LSP.

## Why

Before using dev-core skills, a project needs a `stack.yml` describing its runtime, commands, and paths — plus governance rules in CLAUDE.md, docs stubs, and optional tooling (VS Code MDX preview, LSP). `/env-setup` handles all of this idempotently, whether run standalone or as the first step of `/init`.

## Usage

```
/env-setup           Configure environment (skips already-configured items)
/env-setup --force   Re-run all phases, overwriting existing config
```

Triggers: `"env setup"` | `"setup environment"` | `"configure stack"` | `"scaffold rules"`

## Phases

**Phase 1 — Stack configuration** — copies `stack.yml.example` to `.claude/stack.yml`, asks for critical fields (runtime, backend/frontend paths, test command), prepends `@.claude/stack.yml` import to CLAUDE.md. `stack.yml` is committed (project conventions, no secrets); only `.env` and `.claude/dev-core.yml` are gitignored.

**Phase 1b — Global patterns** — copies `global-patterns.md` (decision protocol, agent discipline, git conventions) to `~/.claude/shared/` and references it from CLAUDE.md.

**Phase 2 — CLAUDE.md Critical Rules** — scaffolds governance rules (dev process, decision protocol, git conventions, Conventional Commits) from stack.yml values. Supports append-only (add missing sections), replace (rewrite all), or skip.

**Phase 3 — Docs scaffolding** (optional) — creates `docs/architecture/`, `docs/standards/`, `docs/guides/` with template stubs. Optionally scaffolds a full Fumadocs Next.js app.

**Phase 4 — VS Code MDX preview** (optional) — adds `"*.mdx": "markdown"` to `.vscode/settings.json`.

**Phase 5 — LSP support** (optional) — sets `ENABLE_LSP_TOOL=1` in `.env` and installs the appropriate language server (`typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`) + Claude Code LSP plugin.

## Safety

- Never overwrites existing `stack.yml` values without `--force` or confirmation
- Commits `stack.yml` (project conventions); gitignores `.env` and `.claude/dev-core.yml` (per-machine secrets)
- Idempotent — all phases skip already-configured items
