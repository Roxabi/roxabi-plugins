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

### 1. Create the plugin directory

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
```

### 2. Write SKILL.md

```markdown
---
name: skill-name
description: 'This skill should be used when the user asks to "trigger1", "trigger2". One-line purpose.'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob, AskUserQuestion
---

# Plugin Name

Brief description of what this plugin does.

## Instructions

### Phase 1 — ...
...

$ARGUMENTS
```

**Rules:**
- `name` and `description` in frontmatter are required
- `description` must be third-person: "This skill should be used when..."
- Include trigger phrases so users can invoke naturally
- `allowed-tools` limits what tools the skill can use
- Must be **project-agnostic** — auto-discover structure, don't hardcode paths
- Use `AskUserQuestion` for any decisions that need user input
- End with `$ARGUMENTS` to accept user-provided args

### 3. Write README.md for the plugin

Create `plugins/<plugin-name>/README.md` with plain English explaining what the plugin does, how to install it, and how to use it.

### 4. Update marketplace.json

Add the plugin to the `plugins` array in `.claude-plugin/marketplace.json`:

```json
{
  "name": "plugin-name",
  "description": "One-line description.",
  "source": "./plugins/plugin-name",
  "category": "category"
}
```

### 5. Update root README.md

Add the plugin to the index table:

```markdown
| [plugin-name](plugins/plugin-name/README.md) | One-line description |
```

### 6. Commit

```
feat(plugins): add <plugin-name> — short description
```

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
