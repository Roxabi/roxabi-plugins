# Creating Plugins

## Creating a New Plugin

Follow these steps to add a native plugin under `plugins/`. Choose its host distribution before
writing the catalog entry.

### Choose distribution

| Path | When | Catalog |
|---|---|---|
| **Claude Code marketplace** | The plugin is supported in Claude Code | `.claude-plugin/marketplace.json` |
| **OMP marketplace** | The plugin is supported in OMP | `.omp-plugin/marketplace.json` |
| **OMP link-only** | Checkout-local or operator tooling | No catalog entry; use `omp plugin link ./plugins/<name>` |

A plugin can support one host or both. Register it only in the catalog for each host it supports.

For an OMP link installation, add `plugins/<plugin-name>/package.json`:

```json
{
  "name": "<plugin-name>",
  "private": true,
  "omp": {}
}
```

Use host-specific plugin metadata only when that host requires it. Do not symlink plugin files into
host-managed skill or agent directories; use the supported marketplace or link installation.

Restart OMP after installing or upgrading a plugin. Do not rely on `/reload-plugins` to apply an
upgrade.

### Step 1 — Create the plugin directory

Each plugin lives in its own folder under `plugins/`. Create the directory and add a `skills/` subfolder for the main skill. You can also add `agents/` or `commands/` folders if the plugin needs them.

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
```

### Step 2 — Write the skill file (SKILL.md)

Create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`. This is the core of the plugin — it tells Claude what the skill does and how to run it.

The file has two parts: a YAML frontmatter header and a markdown body with instructions.

**Frontmatter (required fields):**

- `name` — the skill identifier, in kebab-case (e.g. `summarize-content`)
- `description` — shape depends on invocation mode (see below)
- `version` — semantic version starting at `0.1.0`
- `allowed-tools` — comma-separated list of tools **pre-approved** to run without a permission prompt while the skill is active (e.g. `Read, Edit, Write, Bash, Glob`). It does **not** restrict availability — every tool stays callable regardless; use `disallowed-tools` to actually remove tools from the pool. List every tool the skill drives so it runs prompt-free, including `Agent` if it spawns sub-agents. Always include `ToolSearch` — required to load deferred tools (`EnterWorktree`, `Agent`, `WebFetch`, etc.). 

**Description shapes**

- **Model-invoked** (default — omit `disable-model-invocation`): one-line purpose, then `Triggers: "phrase1" | "phrase2"`. Triggers are how the host decides when to activate the skill; be specific.
- **User-invoked** (slash-only / human entry): one-line human summary only. No `Triggers:` list. Set `disable-model-invocation: true` (required).

**Example frontmatter — model-invoked:**

```yaml
---
name: summarize-content
description: 'Summarize a scoped document set. Triggers: "summarize these files" | "summarize this document".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob
---
```

**Example frontmatter — user-invoked:**

```yaml
---
name: adr
disable-model-invocation: true
description: Create/list Architecture Decision Records.
version: 0.4.1
allowed-tools: Write, Read, Glob, ToolSearch
---
```

**Body guidelines:**

- Write in imperative form ("Scan the directory", not "You should scan the directory")
- Keep it under 3,000 words — move detailed content to `references/` files if needed
- Structure the workflow in numbered phases so Claude follows a clear sequence
- End with `$ARGUMENTS` so the skill can accept user-provided arguments
- The skill must be project-agnostic — auto-discover project structure instead of hardcoding paths
- Present a decision before any destructive action

### Step 3 — Write a README for the plugin
- What the plugin does and why it's useful
- Which hosts it supports
- How to install it from each supported host catalog
- How to use it (trigger phrases, example workflows)
- When to use it (typical scenarios)
- How it works (brief explanation of the approach, no code notation)

See `plugins/issue-triage/README.md` for a Claude Code + OMP plugin or
`plugins/omp-build/README.md` for an OMP-only plugin.

### Step 4 — Register supported hosts

Add the plugin only to the catalog for each host it supports:

- `.claude-plugin/marketplace.json` for Claude Code;
- `.omp-plugin/marketplace.json` for OMP.

Each row names the plugin, describes it, points `source` at its directory, and assigns a category.
The OMP row also requires a version kept in sync with
`plugins/<plugin-name>/package.json#version`, because OMP's install cache is version-keyed.

Do not add an OMP-only plugin to the Claude Code catalog or a Claude-only plugin to the OMP
catalog. Ensure every catalog source points to a directory in this repository.

### Step 5 — Add the plugin to the root README

Add a row to the Plugins table in `README.md`:

```markdown
| [plugin-name](plugins/plugin-name/README.md) | One-line description |
```

### Step 6 — Validate and commit

Run the plugin validator and test suite:

```bash
claude plugin validate .
bun lint && bun typecheck && bun test
```

CI (`bun lint`, `bun typecheck`, `bun test`) runs automatically on push to `main` via `.github/workflows/ci.yml`. PRs must be green before merging.

Then commit with the standard format:

```
feat(plugins): add <plugin-name> — short description
```

---

## Historical external authoring

The active contributor path creates native plugins and registers only their supported hosts.
Historical wrapping and subtree procedures are preserved for evidence in
[archived/docs/legacy-plugin-authoring.md](../archived/docs/legacy-plugin-authoring.md); they do
not define a current plugin distribution path.
