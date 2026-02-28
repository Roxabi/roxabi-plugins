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
- `allowed-tools` — comma-separated list of tools the skill can use (e.g. `Read, Edit, Write, Bash, Glob, AskUserQuestion`)

**Example frontmatter:**

```yaml
---
name: memory-audit
description: 'Audit and drain Claude Code auto-memory — every entry gets resolved (fix/promote/relocate/delete), target is memory=0. Triggers: "memory-audit" | "audit memory" | "clean memory" | "prune memory" | "drain memory".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob, AskUserQuestion
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

## Style

- Single quotes, no semicolons (for any JS/TS in plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands
- Commit format: `<type>(<scope>): <desc>` + `Co-Authored-By`
