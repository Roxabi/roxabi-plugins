# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

## Purpose

This repo is a **multi-plugin container**. Each plugin is a self-contained skill (or set of skills) that works in any Claude Code project — no project-specific dependencies.

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   └── plugin.json              # manifest (name, version, keywords)
├── skills/
│   └── <plugin-name>/
│       └── SKILL.md             # skill definition (YAML frontmatter + instructions)
├── agents/                      # (future) shared agent definitions
│   └── <agent-name>.md
├── commands/                    # (future) slash commands
│   └── <command-name>.md
├── CLAUDE.md                    # this file
├── README.md                    # public-facing docs (auto-generated plugin index)
└── LICENSE                      # MIT
```

## Creating a New Plugin

### 1. Create the skill directory

```bash
mkdir -p skills/<plugin-name>
```

### 2. Write SKILL.md

```markdown
---
description: One-line purpose + trigger phrases. Triggers: "trigger1" | "trigger2".
allowed-tools: Read, Edit, Write, Bash, Glob, AskUserQuestion
---

# Plugin Name

Brief description of what this plugin does.

## Instructions

### Phase 1 — ...
...
```

**Rules:**
- `description` in frontmatter is critical — it's what Claude reads to decide when to invoke the skill
- Include trigger phrases so users can invoke naturally
- `allowed-tools` limits what tools the skill can use
- Must be **project-agnostic** — auto-discover structure, don't hardcode paths
- Use `AskUserQuestion` for any decisions that need user input
- End with `$ARGUMENTS` to accept user-provided args

### 3. Update README.md

Add the plugin to the index table in README.md:

```markdown
| [plugin-name](skills/plugin-name/SKILL.md) | One-line description |
```

### 4. Update plugin.json

Add relevant keywords to the `keywords` array.

### 5. Commit

```
feat(skills): add <plugin-name> — short description
```

## Design Principles

1. **Project-agnostic** — auto-discover structure (CLAUDE.md files, agents, docs dirs), don't assume layout
2. **User is the gate** — always `AskUserQuestion` before destructive actions
3. **Compressed notation** — use formal symbols where they reduce tokens without losing semantics (see roxabi_boilerplate's `/compress` skill for conventions)
4. **Append-only logs** — plugins that track state should use append-only logs for auditability
5. **Recurrence detection** — if a plugin solves recurring problems, track occurrences to find root causes

## Style

- Single quotes, no semicolons (for any JS/TS in plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands
- Commit format: `<type>(<scope>): <desc>` + `Co-Authored-By`
