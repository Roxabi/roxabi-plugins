@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

## Purpose

Repo = **marketplace** — collection of independent plugins, each self-contained + individually installable.

## TL;DR

- **Project:** roxabi-plugins
- **Before work:** `/dev #N` = single entry — picks tier + drives lifecycle
- **Never:** `--force` / `--hard` / `--amend`
- **Always:** use matching skill even w/o slash cmd

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   ├── marketplace.json         # marketplace manifest (native + wrapped plugins)
│   └── curated-marketplaces.json  # endorsed external marketplaces (¬raw skill repos)
├── plugins/
│   ├── shared/
│   │   └── references/          # cross-plugin refs (${CLAUDE_PLUGIN_ROOT}/../shared/)
│   │       └── decision-presentation.md  # Pattern A/B/C protocol
│   └── <plugin-name>/
│       ├── README.md            # human docs
│       ├── skills/
│       │   └── <skill-name>/
│       │       └── SKILL.md     # YAML frontmatter + instructions
│       ├── agents/              # (optional) agent defs
│       │   └── <agent-name>.md
│       └── commands/            # (optional) slash commands
│           └── <command-name>.md
├── CLAUDE.md                    # this
├── README.md                    # public docs
└── LICENSE                      # MIT
```

## Pointers

- Create/fork plugins → [`docs/CREATE-PLUGIN-GUIDE.md`](docs/CREATE-PLUGIN-GUIDE.md). Triggers: "create plugin" | "new plugin" | "fork plugin" | "subtree"
- External ecosystem (curated marketplaces, wrapped plugins, upstream drift) → [`docs/EXTERNAL-ECOSYSTEM.md`](docs/EXTERNAL-ECOSYSTEM.md). Triggers: "external plugin" | "upstream sync" | "curated marketplace" | "drift"
- Data management details (plugin.json data format, path resolution, vault layout) → [`docs/data-management.md`](docs/data-management.md)
- Plugin cache internals (hash dirs, path vars, sync workflow) → [`docs/plugin-cache.md`](docs/plugin-cache.md)

## Documentation

Keep all READMEs current. Adding/modifying/removing a plugin → update:
- `plugins/<plugin-name>/README.md` — plugin's own docs
- `README.md` — root plugin index table

## Design Principles

1. **Project-agnostic** — auto-discover (CLAUDE.md, agents, docs dirs), ¬assume layout
2. **User is the gate** — always present DP/A before destructive actions
3. **Compressed notation** — use formal symbols where they cut tokens w/o losing semantics
4. **Append-only logs** — state-tracking plugins use append-only for auditability
5. **Recurrence detection** — if plugin solves recurring problems, track occurrences → root causes

## Data Management (invariants)

- **Default:** `~/.roxabi-vault/` — all user data, never in repo. Override: `ROXABI_VAULT_HOME`.
- `data.root` ∈ `plugin.json` must be unique across plugins (enforced by `tools/validate_plugins.py`).
- **Zero personal data** ∈ repo — fictional only ∈ `examples/`. English names only.
- Path resolution: `from roxabi_sdk.paths import ...` — `roxabi_sdk/` @ repo root = single source of truth; sync script copies to each plugin cache.
- Vault/indexing → [roxabi-vault](https://github.com/Roxabi/roxabi-vault).

→ [`docs/data-management.md`](docs/data-management.md) for full `plugin.json` data format, shared vs exclusive dirs, all rules.

## Editing Plugins (invariants)

- **Source of truth** = repo: `plugins/<plugin-name>/`. Cache @ `~/.claude/plugins/cache/roxabi-marketplace/<plugin-name>/<hash>/` is a copy.
- **Never edit cache only** — changes lost on plugin update/reinstall.
- **Workflow:** edit repo source → commit + push → `./sync-plugins.sh --local` (∨ `./sync-plugins.sh` for push + Machine 1).

→ [`docs/plugin-cache.md`](docs/plugin-cache.md) — how the hash-keyed cache works, `${CLAUDE_SKILL_DIR}` vs `${CLAUDE_PLUGIN_ROOT}`, sync script details.

## Style

- Single quotes, no semicolons (any JS/TS ∈ plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands

## Gotchas

- Always run rsync sync script after editing plugin source — cache ¬auto-updated
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` links ∈ SKILL.md = runtime-resolved, ¬render ∈ GitHub/VS Code previews
- **3rd-party plugin MCP servers** — external plugins (e.g. `knowledge-work-plugins/design`) may bundle `.mcp.json` w/ MCP servers (Slack, Figma, Linear, …) → auth warnings on startup. Disable w/o removing: empty `mcpServers` ∈ both `~/.claude/plugins/marketplaces/<marketplace>/<plugin>/.mcp.json` ∧ `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`, then `git update-index --skip-worktree <path>` ∈ marketplace repo → `git pull` won't restore them.
