# Creating and Forking Plugins

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

- `name` — the skill identifier, in kebab-case (e.g. `compress`)
- `description` — one-line purpose followed by `Triggers: "phrase1" | "phrase2"`. This is how Claude decides when to activate the skill, so be specific
- `version` — semantic version starting at `0.1.0`
- `allowed-tools` — comma-separated list of tools the skill can use (e.g. `Read, Edit, Write, Bash, Glob`). Always include `ToolSearch` — required to load deferred tools (`EnterWorktree`, `Task*`, `WebFetch`, etc.). Always include `Read` if the skill presents decisions (needed to load the decision protocol from `plugins/shared/references/`).

**Example frontmatter:**

```yaml
---
name: compress
description: 'Rewrite agent/skill definitions using compact math/logic notation. Triggers: "compress" | "compress skill" | "shorten this" | "make it formal".'
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
- Present a decision before any destructive action (Pattern A — see `plugins/shared/references/decision-presentation.md`)

### Step 3 — Write a README for the plugin

Create `plugins/<plugin-name>/README.md` in plain English. This is for humans browsing the repo or the marketplace. It should cover:

- What the plugin does and why it's useful
- How to install it (`claude plugin marketplace add Roxabi/roxabi-plugins` then `claude plugin install <plugin-name>`)
- How to use it (trigger phrases, example workflows)
- When to use it (typical scenarios)
- How it works (brief explanation of the approach, no code notation)

See `plugins/compress/README.md` for an example.

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

Run the plugin validator and test suite:

```bash
claude plugin validate .
bun lint && bun typecheck && bun test
```

CI (`bun lint`, `bun typecheck`, `bun test`) runs automatically on push to `main`/`staging` via `.github/workflows/ci.yml`. PRs must be green before merging.

Then commit with the standard format:

```
feat(plugins): add <plugin-name> — short description
```

---

## Forking an Upstream Plugin

When adopting a high-quality external skill rather than building from scratch, use `git subtree` to vendor it into the marketplace while keeping the ability to pull upstream updates.

> **Native vs Wrapped plugins** — plugins built by Roxabi are *native*. Plugins forked from external raw-skill repos (no versioning, no install mechanism) are *wrapped*: Roxabi adds the plugin structure (frontmatter, README, marketplace entry) and vendors the source via `git subtree`. Both appear in `marketplace.json`. For endorsed external repos that already ship as proper plugin marketplaces, add them to `curated-marketplaces.json` instead — `/ci-setup` discovers and offers them at runtime without vendoring.

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

Follow Steps 4–6 from "Creating a New Plugin" above (marketplace.json, root README, commit).

### Pulling upstream updates later

```bash
git subtree pull --prefix=plugins/<plugin-name> \
  https://github.com/<owner>/<repo>.git main --squash
```

Keep local changes (frontmatter, README) minimal to avoid merge conflicts. Put the pull command in the commit message for easy reference.
