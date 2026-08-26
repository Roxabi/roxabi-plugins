# Creating and Forking Plugins

## Creating a New Plugin

Follow these steps to add a plugin under `plugins/`. **Pick a distribution path first** — marketplace (catalog install) or link-only (OMP git/link, no catalog entry).

### Choose distribution

| Path | When | OMP install | Catalog |
|---|---|---|---|
| **Marketplace** | Ship to all users via catalog; Claude Code + OMP marketplace pipes | `omp plugin install <name>@roxabi-marketplace` (requires `claude-plugins` on) | Add to `.claude-plugin/marketplace.json` **and** `.omp-plugin/marketplace.json` |
| **Link-only** | Monorepo subdir, internal/operator tooling, or `claude-plugins` off | `omp plugin link ./plugins/<name>` from repo root | **No** catalog entry; **no** `plugins/<name>/.omp-plugin/plugin.json` |


For **link-only** (or any OMP git/link install), add `plugins/<plugin-name>/package.json`:

```json
{
  "name": "<plugin-name>",
  "private": true,
  "omp": {}
}
```

Link-only plugins require this file; marketplace-only plugins can omit it unless you also test with `omp plugin link`. Use `omp.extensions` only for in-process hook factories — not required for skills/agents/commands.

Verify after install:

```bash
omp plugin doctor    # expect plugin:<name>
omp plugin list      # npm Plugins → <name>@…
```

**Reload vs restart** after edits (link or marketplace):

| Change | Pick up |
|---|---|
| `skills/`, `commands/`, MCP config | `/reload-plugins` |
| `hooks/`, `omp.extensions`, **new/changed `agents/*.md`** | **restart** OMP session |

Do **not** symlink plugin files into `~/.omp/agent/skills/` or `~/.omp/agent/agents/` — that shadows the plugin. Use `link` or marketplace install + restart.

### Step 1 — Create the plugin directory

Each plugin lives in its own folder under `plugins/`. Create the directory and add a `skills/` subfolder for the main skill. You can also add `agents/` or `commands/` folders if the plugin needs them.

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
```

### Step 2 — Write the skill file (SKILL.md)

Create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`. This is the core of the plugin — it tells Claude what the skill does and how to run it.

The file has two parts: a YAML frontmatter header and a markdown body with instructions.

**Frontmatter (required fields):**

- `name` — the skill identifier, in kebab-case (e.g. `compress`)
- `description` — shape depends on invocation mode (see below)
- `version` — semantic version starting at `0.1.0`
- `allowed-tools` — comma-separated list of tools **pre-approved** to run without a permission prompt while the skill is active (e.g. `Read, Edit, Write, Bash, Glob`). It does **not** restrict availability — every tool stays callable regardless; use `disallowed-tools` to actually remove tools from the pool. List every tool the skill drives so it runs prompt-free, including `Agent` if it spawns sub-agents. Always include `ToolSearch` — required to load deferred tools (`EnterWorktree`, `Agent`, `WebFetch`, etc.). 

**Description shapes**

- **Model-invoked** (default — omit `disable-model-invocation`): one-line purpose, then `Triggers: "phrase1" | "phrase2"`. Triggers are how the host decides when to activate the skill; be specific.
- **User-invoked** (slash-only / human entry): one-line human summary only. No `Triggers:` list. Set `disable-model-invocation: true` (required).

**Example frontmatter — model-invoked:**

```yaml
---
name: compress
description: 'Compress agent/skill definitions using math/logic notation. Triggers: "compress" | "compress skill" | "compress agent" | "compress context" | "shorten this" | "make it formal" | "use formal notation" | "expand notation" | "lint notation" | "derive pattern from skills".'
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
- How to install it:
  - **Marketplace:** `claude plugin marketplace add Roxabi/roxabi-plugins` then `claude plugin install <plugin-name>`; OMP: `omp plugin install <plugin-name>@roxabi-marketplace`
  - **Link-only:** `omp plugin link ./plugins/<plugin-name>` from a checkout (requires `package.json` with `"omp": {}`)
- How to use it (trigger phrases, example workflows)
- When to use it (typical scenarios)
- How it works (brief explanation of the approach, no code notation)
- Reload vs restart table if the plugin ships agents, hooks, or `omp.extensions`

See `plugins/compress/README.md` (marketplace) or `plugins/omp-build/README.md` (link-only) for examples.

### Step 4 — Register in marketplace catalogs (marketplace path only)

Skip this step for link-only plugins.

Add an entry to the `plugins` array in **both** catalog files at the repo root:

- `.claude-plugin/marketplace.json` — Claude Code marketplace
- `.omp-plugin/marketplace.json` — OMP marketplace (`claude-plugins` provider)

```json
{
  "name": "plugin-name",
  "description": "One-line description of what the plugin does.",
  "source": "./plugins/plugin-name",
  "category": "category"
}
```

Add `plugins/<plugin-name>/.claude-plugin/plugin.json` (Claude) and, for OMP marketplace delivery, `plugins/<plugin-name>/.omp-plugin/plugin.json`. Link-only plugins omit per-plugin `.omp-plugin/` metadata.

Categories used so far: `maintenance`, `development`, `workflow`, `productivity`, `content`. Pick the closest fit or create a new one if needed.

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

## Forking an Upstream Plugin

When adopting a high-quality external skill rather than building from scratch, use `git subtree` to vendor it into the marketplace while keeping the ability to pull upstream updates.

> **Native vs Wrapped plugins** — plugins built by Roxabi are *native*. Plugins forked from external raw-skill repos (no versioning, no install mechanism) are *wrapped*: Roxabi adds the plugin structure (frontmatter, README, marketplace entries) and vendors the source via `git subtree`. Both appear in `.claude-plugin/marketplace.json` and `.omp-plugin/marketplace.json`. For endorsed external repos that already ship as proper plugin marketplaces, add them to `curated-marketplaces.json` instead — `/ci-setup` discovers and offers them at runtime without vendoring.

### Step 1 — Add as a subtree

```bash
git subtree add --prefix=plugins/<plugin-name> \
  https://github.com/<owner>/<repo>.git main --squash
```

This copies all files into `plugins/<plugin-name>/` as a normal commit (no submodule complexity).

### Step 2 — Restructure into marketplace layout

The external skill likely has a flat structure. Move files into the standard layout:

```bash
mkdir -p plugins/<plugin-name>/skills/<skill-name>
mv plugins/<plugin-name>/SKILL.md plugins/<plugin-name>/skills/<skill-name>/
# move any supporting files alongside SKILL.md
```

### Step 3 — Adapt the frontmatter

The upstream SKILL.md frontmatter won't have the required fields. Update it:

```yaml
---
name: skill-name
description: 'One-line description. Triggers: "phrase1" | "phrase2".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---
```

### Step 4 — Replace the README

Overwrite the upstream README with a Roxabi marketplace README (install instructions, trigger phrases, how it works). Credit the upstream author with a "Forked from" line.

### Steps 5–6 — Register and commit

Follow Steps 4–6 from "Creating a New Plugin" above (both marketplace catalogs, root README, commit).

### Pulling upstream updates later

```bash
git subtree pull --prefix=plugins/<plugin-name> \
  https://github.com/<owner>/<repo>.git main --squash
```

Keep local changes (frontmatter, README) minimal to avoid merge conflicts. Put the pull command in the commit message for easy reference.
