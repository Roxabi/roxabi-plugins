@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

## Purpose

This repo is a **marketplace** — a collection of independent plugins. Each plugin is self-contained and individually installable.

## TL;DR

- **Project:** roxabi-plugins
- **Before work:** Use `/dev #N` as the single entry point — it determines tier and drives the full lifecycle
- **Never** use `--force`/`--hard`/`--amend`
- **Always** use appropriate skill even without slash command

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   ├── marketplace.json         # marketplace manifest (lists all plugins — native + wrapped)
│   └── curated-marketplaces.json  # endorsed external plugin marketplaces (not raw skill repos)
├── plugins/
│   ├── shared/
│   │   └── references/          # cross-plugin shared references (accessible via ${CLAUDE_PLUGIN_ROOT}/../shared/)
│   │       └── decision-presentation.md  # decision protocol (Pattern A/B/C)
│   └── <plugin-name>/
│       ├── README.md            # human-readable docs
│       ├── skills/
│       │   └── <skill-name>/
│       │       └── SKILL.md     # skill definition (YAML frontmatter + instructions)
│       ├── agents/              # (optional) agent definitions
│       │   └── <agent-name>.md
│       └── commands/            # (optional) slash commands
│           └── <command-name>.md
├── CLAUDE.md                    # this file
├── README.md                    # public-facing docs
└── LICENSE                      # MIT
```

## Creating or Forking Plugins

→ [./docs/CREATE-PLUGIN-GUIDE.md](./docs/CREATE-PLUGIN-GUIDE.md) — step-by-step: create plugin (6 steps), fork upstream, git subtree, pull updates.
Triggers: "create plugin" | "new plugin" | "fork plugin" | "add plugin" | "subtree"

## External Ecosystem

→ [./docs/EXTERNAL-ECOSYSTEM.md](./docs/EXTERNAL-ECOSYSTEM.md) — curated marketplaces, wrapped plugins (copy/subtree), deprecation, upstream drift detection.
Triggers: "external plugin" | "upstream sync" | "curated marketplace" | "wrapped plugin" | "drift"

## Documentation

All READMEs must be kept up to date at all times. When adding, modifying, or removing a plugin, update:

- `plugins/<plugin-name>/README.md` — the plugin's own documentation
- `README.md` — the root plugin index table

## Design Principles

1. **Project-agnostic** — auto-discover structure (CLAUDE.md files, agents, docs dirs), don't assume layout
2. **User is the gate** — always present a decision (Pattern A) before destructive actions
3. **Compressed notation** — use formal symbols where they reduce tokens without losing semantics
4. **Append-only logs** — plugins that track state should use append-only logs for auditability
5. **Recurrence detection** — if a plugin solves recurring problems, track occurrences to find root causes

## Data Management Convention

Plugins that produce or consume user data follow these rules:

### Storage

- **Default location**: `~/.roxabi-vault/` — all user data lives here, never in the repo
- **Override**: set `ROXABI_VAULT_HOME` environment variable for a custom location
- **Permissions**: directories created with mode `0o700`
- **Shared directories**: `content/`, `ideas/`, `learnings/` — used by multiple plugins
- **Exclusive directories**: `cv/`, `invoices/`, `linkedin-apply/` — owned by one plugin (`data.root` in plugin.json)

### plugin.json extended format

Plugins with data declare it in `plugin.json`:

```json
{
  "data": {
    "root": "cv",
    "directories": ["generated", "adapted"],
    "files": {
      "cv_data.json": {
        "description": "Master CV data",
        "sensitive": true,
        "example": "examples/cv_data.example.json"
      }
    },
    "shared": []
  }
}
```

- `data.root` must be unique across all plugins (enforced by `tools/validate_plugins.py`)
- `data.shared` lists shared directories the plugin reads/writes
- `data.files[].example` points to a template with fictional data in `examples/`

### Path resolution

All plugins use `roxabi_sdk/paths.py` for path resolution. The canonical copy lives at `roxabi_sdk/paths.py` (repo root). The sync script copies `roxabi_sdk/` into each plugin cache dir so imports work in both repo and installed contexts.

Key functions: `get_vault_home()`, `get_plugin_data(name)`, `get_shared_dir(name)`, `get_config(name)`, `ensure_dir(path)`.

Vault/indexing functionality has moved to [roxabi-vault](https://github.com/Roxabi/roxabi-vault).

### Rules

1. **Zero personal data** in the repo — use fictional data in `examples/`
2. **English names** — `invoices/` not `factures/`, skills in English
3. **Self-check in skills** — verify preconditions at start, suggest init skill if data missing
4. **Shared SDK** — `roxabi_sdk/` at repo root is the single source of truth for path resolution. Sync script copies it into each plugin cache dir. Import via `from roxabi_sdk.paths import ...`
5. **CI checks** — `tools/validate_plugins.py` enforces no personal data, unique `data.root`, examples exist

## Editing Plugins

**Source of truth** is always the repo: `plugins/<plugin-name>/` in this repository.

The installed (running) copies live in the plugin cache at `~/.claude/plugins/cache/roxabi-marketplace/<plugin-name>/<hash>/`. These are independent copies — editing one does not update the other.

### How the cache works

Each project that has a plugin installed uses a specific cache dir identified by a hash (e.g. `6011eb380f4f`). Multiple projects can have different hashes for the same plugin, and old hashes accumulate over time. **Editing the source never touches the cache automatically.**

### Workflow

1. **Edit the repo source first** — `plugins/<plugin-name>/skills/...`, `plugins/<plugin-name>/agents/...`, etc.
2. **Commit and push.**
3. **Propagate to all projects** — run from the repo root:
   ```bash
   ./sync-plugins.sh --local
   ```
   Syncs all plugins into every local cache dir (semver + hex-hash). Use `./sync-plugins.sh` to also push and sync Machine 1.

**Skill path variables** — substituted at skill load time by Claude Code (not shell env vars):
- `${CLAUDE_SKILL_DIR}` — resolves to the skill's own directory (e.g. `…/plugins/dev-core/skills/implement`)
- `${CLAUDE_PLUGIN_ROOT}` — resolves to the plugin root in the **marketplace clone** (e.g. `~/.claude/plugins/marketplaces/roxabi-marketplace/plugins/dev-core`)

Use `${CLAUDE_PLUGIN_ROOT}` for cross-skill references within the same plugin (e.g. `${CLAUDE_PLUGIN_ROOT}/skills/shared/references/`).
Use `${CLAUDE_PLUGIN_ROOT}/../shared/` to reference cross-plugin shared files in `plugins/shared/` (e.g. the decision protocol).

### Rules

- **Never edit only the cache** — changes are lost on plugin update/reinstall
- **Always commit repo source** — the cache is ephemeral, the repo is permanent
- **Run the sync script after every push** — so all projects immediately get the latest version

## Style

- Single quotes, no semicolons (for any JS/TS in plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands

## Gotchas

- Always run the rsync sync script after editing plugin source — the cache is not updated automatically
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` links in SKILL.md files are runtime-resolved and do not render in GitHub or VS Code previews
- **Third-party plugin MCP servers** — external plugins (e.g. `knowledge-work-plugins/design`) can bundle `.mcp.json` files with MCP servers (Slack, Figma, Linear, etc.) that cause auth warnings on startup. To disable without removing the plugin: empty `mcpServers` in both `~/.claude/plugins/marketplaces/<marketplace>/<plugin>/.mcp.json` and `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`, then run `git update-index --skip-worktree <path>` in the marketplace repo to prevent `git pull` from restoring them