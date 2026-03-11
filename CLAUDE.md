@.claude/stack.yml
# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

## Purpose

This repo is a **marketplace** — a collection of independent plugins. Each plugin is self-contained and individually installable.

## TL;DR

- **Project:** roxabi-plugins
- **Before work:** Use `/dev #N` as the single entry point — it determines tier (S / F-lite / F-full) and drives the full lifecycle
- **Always** `AskUserQuestion` for choices — never plain-text questions
- **Never** commit without asking, push without request, or use `--force`/`--hard`/`--amend`
- **Always** use appropriate skill even without slash command

### AskUserQuestion

Always `AskUserQuestion` for: decisions, choices (≥2 options), approach proposals.
**Never** plain-text "Do you want..." / "Should I..." → use the tool.

### Git

Format: `<type>(<scope>): <desc>` + `Co-Authored-By: Claude <model> <noreply@anthropic.com>`
Types: feat|fix|refactor|docs|style|test|chore|ci|perf
Never push without request. Never force/hard/amend. Hook fail → fix + NEW commit.

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   ├── marketplace.json         # marketplace manifest (lists all plugins — native + wrapped)
│   └── curated-marketplaces.json  # endorsed external plugin marketplaces (not raw skill repos)
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

- `name` — the skill identifier, in kebab-case (e.g. `compress`)
- `description` — one-line purpose followed by `Triggers: "phrase1" | "phrase2"`. This is how Claude decides when to activate the skill, so be specific
- `version` — semantic version starting at `0.1.0`
- `allowed-tools` — comma-separated list of tools the skill can use (e.g. `Read, Edit, Write, Bash, Glob`). To use `AskUserQuestion`, include both `ToolSearch` and `AskUserQuestion` — `ToolSearch` is required to load the deferred tool before calling it.

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
- Use `AskUserQuestion` before any destructive action so the user stays in control

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

## External Ecosystem

Roxabi endorses and vendors external Claude Code plugins via two mechanisms. The registry
`.claude-plugin/external-registry.json` is the source of truth for all external sources.

### Directory convention

| Directory | Contents |
|-----------|----------|
| `plugins/` | Native Roxabi plugins — built and owned by Roxabi |
| `external/` | Curated/vendored external plugins — sourced from upstream repos |

Both appear in `.claude-plugin/marketplace.json` so users install them the same way.

> **Note:** The `external/` directory is created when the first external plugin is vendored (see issue #63 — initial audit). This section documents the convention for when it exists.

### Case 1 — Curated Marketplace

An external repo that is itself a proper plugin marketplace (has `marketplace.json`, versioned
installs, works with `claude plugin marketplace add <url>`). Users install from it directly —
no vendoring into this repo.

**Qualify if ALL:**
- [ ] Ships `marketplace.json` with versioned plugins
- [ ] Has working install mechanism (`claude plugin marketplace add <url>`)
- [ ] Last commit ≤ 90 days ago
- [ ] Reviewed skills with clear descriptions + trigger phrases
- [ ] < 50% overlap with native Roxabi plugins

**To add a curated marketplace:**
1. Verify all criteria above manually
2. Add entry to `.claude-plugin/external-registry.json` under `curated_marketplaces`
3. Sync to `.claude-plugin/curated-marketplaces.json` `marketplaces` array

### Case 2 — Wrapped Plugin

A raw skill repo (SKILL.md files, no install mechanism) vendored into `external/`. Choose
strategy at wrapping time — record in `sync_strategy` field.

**Qualify if ALL:**
- [ ] High-quality SKILL.md (clear instructions, scoped triggers)
- [ ] Last commit ≤ 90 days ago
- [ ] Fills a gap not covered by native plugins
- [ ] Compatible license (MIT, Apache 2.0, etc.)
- [ ] Upstream author notified/credited in plugin README

**Copy strategy** (flat SKILL.md repos — simpler, no merge conflicts):
```bash
# 1. Copy files into external/
cp -r <upstream-skill-dir>/ external/<name>/
# 2. Record upstream HEAD SHA
SHA=$(git ls-remote <repo-url>.git refs/heads/main | awk '{print $1}')
# 3. Add to external-registry.json (sync_strategy: "copy", last_sync_commit: "$SHA")
# 4. Add to marketplace.json ("source": "./external/<name>")
```

**Subtree strategy** (plugins with meaningful directory structure):
```bash
git subtree add --prefix=external/<name> <url>.git <branch> --squash
# Add to external-registry.json (sync_strategy: "subtree", subtree_prefix: "external/<name>")
# Add to marketplace.json ("source": "./external/<name>")
```

**To update a wrapped plugin:**

Copy strategy:
```bash
SHA=$(git ls-remote <repo-url>.git refs/heads/main | awk '{print $1}')
cp -r <upstream-skill-dir>/ external/<name>/
# Update external-registry.json: last_sync_commit, last_sync_date
```

Subtree strategy:
```bash
git subtree pull --prefix=external/<name> <url>.git <branch> --squash
# Update external-registry.json: last_sync_commit, last_sync_date
```

### Case 3 — Deprecation

**Trigger if ANY:**
- Upstream archived/deleted with no suitable replacement
- > 12 months since last commit (any commit counts)
- Superseded by a better native or external alternative
- License changed to incompatible terms

**To deprecate:**
1. Set `status: deprecated` in `external-registry.json` entry
2. Remove from `marketplace.json` (wrapped) or `curated-marketplaces.json` (curated)
3. Optionally remove plugin directory: `git rm -r external/<name>` (wrapped only)
4. Add deprecation date + reason to `notes` field in registry

### Upstream drift detection

CI runs weekly (Mondays 09:00 UTC) and on manual dispatch via `.github/workflows/upstream-watch.yml`.
When upstream has new commits vs `last_sync_commit`, it opens a GitHub issue labelled `upstream-update`.
Review the diff and decide: update, skip, or deprecate. **CI never auto-merges.**

Trigger manually: GitHub Actions → Upstream Watch → Run workflow.

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

Vault/indexing functionality has moved to [roxabi-memory](https://github.com/Roxabi/roxabi-memory).

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

**Find the active cache hash** — when a skill runs, `$CLAUDE_PLUGIN_ROOT` contains the full cache path (e.g. `~/.claude/plugins/cache/roxabi-marketplace/dev-core/6011eb380f4f/skills/init`). The hash segment (`6011eb380f4f`) identifies the active cache directory if you need to target a single one.

**Skill path variables** — use `${CLAUDE_SKILL_DIR}` for files under the skill's own directory; use `${CLAUDE_PLUGIN_ROOT}` for cross-skill references (e.g., `shared/references/`).

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