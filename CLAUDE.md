# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

## Purpose

This repo is a **marketplace** — a collection of independent plugins. Each plugin is self-contained and individually installable.

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   └── marketplace.json         # marketplace manifest (lists all plugins)
├── plugins/
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

## Creating a New Plugin

Follow these steps in order to add a new plugin to the marketplace.

### Step 1 — Create the plugin directory

Each plugin lives in its own folder under `plugins/`. Create the directory and add a `skills/` subfolder for the main skill. You can also add `agents/` or `commands/` folders if the plugin needs them.

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
```

### Step 2 — Write the skill file (SKILL.md)

Create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`. This is the core of the plugin — it tells Claude what the skill does and how to run it.

The file has two parts: a YAML frontmatter header and a markdown body with instructions.

**Frontmatter (required fields):**

- `name` — the skill identifier, in kebab-case (e.g. `memory-audit`)
- `description` — one-line purpose followed by `Triggers: "phrase1" | "phrase2"`. This is how Claude decides when to activate the skill, so be specific
- `version` — semantic version starting at `0.1.0`
- `allowed-tools` — comma-separated list of tools the skill can use (e.g. `Read, Edit, Write, Bash, Glob`). **Never include `AskUserQuestion`** — it is not a valid tool and will cause a bug.

**Example frontmatter:**

```yaml
---
name: memory-audit
description: 'Audit and drain Claude Code auto-memory — every entry gets resolved (fix/promote/relocate/delete), target is memory=0. Triggers: "memory-audit" | "audit memory" | "clean memory" | "prune memory" | "drain memory".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob
---
```

**Body guidelines:**

- Write in imperative form ("Scan the directory", not "You should scan the directory")
- Keep it under 3,000 words — move detailed content to `references/` files if needed
- Structure the workflow in numbered phases so Claude follows a clear sequence
- End with `$ARGUMENTS` so the skill can accept user-provided arguments
- The skill must be project-agnostic — auto-discover project structure instead of hardcoding paths
- Use `AskUserQuestion` before any destructive action so the user stays in control

### Step 3 — Write a README for the plugin

Create `plugins/<plugin-name>/README.md` in plain English. This is for humans browsing the repo or the marketplace. It should cover:

- What the plugin does and why it's useful
- How to install it (`claude plugin marketplace add Roxabi/roxabi-plugins` then `claude plugin install <plugin-name>`)
- How to use it (trigger phrases, example workflows)
- When to use it (typical scenarios)
- How it works (brief explanation of the approach, no code notation)

See `plugins/memory-audit/README.md` for an example.

### Step 4 — Register the plugin in marketplace.json

Add an entry to the `plugins` array in `.claude-plugin/marketplace.json`:

```json
{
  "name": "plugin-name",
  "description": "One-line description of what the plugin does.",
  "source": "./plugins/plugin-name",
  "category": "category"
}
```

Categories used so far: `maintenance`. Pick the closest fit or create a new one if needed.

### Step 5 — Add the plugin to the root README

Add a row to the Plugins table in `README.md`:

```markdown
| [plugin-name](plugins/plugin-name/README.md) | One-line description |
```

### Step 6 — Validate and commit

Run the plugin validator to check the structure:

```bash
claude plugin validate .
```

Then commit with the standard format:

```
feat(plugins): add <plugin-name> — short description
```

## Documentation

All READMEs must be kept up to date at all times. When adding, modifying, or removing a plugin, update:

- `plugins/<plugin-name>/README.md` — the plugin's own documentation
- `README.md` — the root plugin index table

## Design Principles

1. **Project-agnostic** — auto-discover structure (CLAUDE.md files, agents, docs dirs), don't assume layout
2. **User is the gate** — always `AskUserQuestion` before destructive actions
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
- **Exclusive directories**: `cv/`, `invoices/` — owned by one plugin (`data.root` in plugin.json)

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
  },
  "vault": {
    "optional": true,
    "indexes": { "category": "cv", "types": ["cv", "cover-letter"] }
  }
}
```

- `data.root` must be unique across all plugins (enforced by `tools/validate_plugins.py`)
- `data.shared` lists shared directories the plugin reads/writes
- `data.files[].example` points to a template with fictional data in `examples/`
- `vault.optional: true` means the plugin works without vault installed

### Path resolution

All plugins use `_lib/paths.py` for path resolution. The canonical copy lives at `plugins/vault/_lib/paths.py`. Consumer plugins vendor a copy at `scripts/_lib/paths.py`.

Key functions: `get_vault_home()`, `get_plugin_data(name)`, `get_shared_dir(name)`, `get_config(name)`, `ensure_dir(path)`, `vault_available()`, `vault_healthy()`.

### Vault integration pattern

```python
# ALWAYS: save to ~/.roxabi-vault/
save_dir = ensure_dir(get_vault_home() / 'content')
(save_dir / filename).write_text(content)

# OPTIONAL: index if vault is healthy
if vault_healthy():
    try:
        index_content(...)
    except Exception:
        pass  # degraded: file saved, not indexed
```

### Rules

1. **Zero personal data** in the repo — use fictional data in `examples/`
2. **English names** — `invoices/` not `factures/`, skills in English
3. **Self-check in skills** — verify preconditions at start, suggest init skill if data missing
4. **Vendoring** — copy `_lib/paths.py` from vault, don't symlink
5. **CI checks** — `tools/validate_plugins.py` enforces no personal data, unique `data.root`, examples exist

## Editing Plugins

**Source of truth** is always the repo: `plugins/<plugin-name>/` in this repository.

The installed (running) copies live in the plugin cache at `~/.claude/plugins/cache/roxabi-marketplace/<plugin-name>/<hash>/`. These are independent copies — editing one does not update the other.

### How the cache works

Each project that has a plugin installed uses a specific cache dir identified by a hash (e.g. `6011eb380f4f`). Multiple projects can have different hashes for the same plugin, and old hashes accumulate over time. **Editing the source never touches the cache automatically.**

### Workflow

1. **Edit the repo source first** — `plugins/<plugin-name>/skills/...`, `plugins/<plugin-name>/agents/...`, etc.
2. **Commit and push.**
3. **Propagate to all projects** — run this script from the repo root to sync every plugin into every cache dir:
   ```bash
   REPO=~/projects/roxabi-plugins
   CACHE=~/.claude/plugins/cache/roxabi-marketplace
   for plugin_dir in "$REPO/plugins"/*/; do
     plugin=$(basename "$plugin_dir")
     [ -d "$CACHE/$plugin" ] && for h in "$CACHE/$plugin"/*/; do
       rsync -a --exclude='__tests__' --exclude='node_modules' --exclude='.orphaned_at' --exclude='.dashboard.pid' \
         "$plugin_dir" "$h"
     done
   done
   ```
   This covers all projects at once — no need to visit each one individually.

**Find the active cache hash** — when a skill runs, `$CLAUDE_PLUGIN_ROOT` contains the full cache path (e.g. `~/.claude/plugins/cache/roxabi-marketplace/dev-core/6011eb380f4f/skills/init`). The hash segment (`6011eb380f4f`) identifies the active cache directory if you need to target a single one.

### Rules

- **Never edit only the cache** — changes are lost on plugin update/reinstall
- **Always commit repo source** — the cache is ephemeral, the repo is permanent
- **Run the sync script after every push** — so all projects immediately get the latest version

## Style

- Single quotes, no semicolons (for any JS/TS in plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands
- Commit format: `<type>(<scope>): <desc>` + `Co-Authored-By`
