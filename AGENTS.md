# Roxabi Plugins

Open-source Claude Code plugins by Roxabi. Context engineering tools for teams using Claude Code.

Stack conventions — paths, commands, formatter, test runner — live in [`.dev/stack.yml`](.dev/stack.yml).

## Purpose

Repo = **marketplace** — collection of independent plugins, each self-contained + individually installable.

## TL;DR

- **Project:** roxabi-plugins

## Structure

```
roxabi-plugins/
├── .claude-plugin/
│   ├── marketplace.json         # Claude catalog: issue-triage only
│   └── curated-marketplaces.json  # endorsed external marketplaces
├── .omp-plugin/
│   └── marketplace.json         # OMP catalog: issue-triage + omp-build
├── plugins/
│   ├── issue-triage/
│   └── omp-build/
├── archived/                    # inert historical source, not installable
├── AGENTS.md
├── README.md
└── LICENSE                      # AGPL-3.0
```

## Pointers

- Create/fork plugins → [`docs/CREATE-PLUGIN-GUIDE.md`](docs/CREATE-PLUGIN-GUIDE.md). Triggers: "create plugin" | "new plugin" | "fork plugin" | "subtree"
- External ecosystem (curated marketplaces, wrapped plugins, upstream drift) → [`docs/EXTERNAL-ECOSYSTEM.md`](docs/EXTERNAL-ECOSYSTEM.md). Triggers: "external plugin" | "upstream sync" | "curated marketplace" | "drift"
- Data management details (plugin.json data format, path resolution, vault layout) → [`docs/data-management.md`](docs/data-management.md)
- Plugin cache internals (hash dirs, path vars, sync workflow) → [`docs/plugin-cache.md`](docs/plugin-cache.md)
- Issue tracker contract (relations, tiers, sibling rule — read before any issue write) → [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md). Triggers: "create issue" | "blocked by" | "parent issue" | "size label" | "publish to the tracker" | "amend issue" | "edit the body" | "update the ticket"

## Documentation

Keep all READMEs current. Adding/modifying/removing a plugin → update:
- `plugins/<plugin-name>/README.md` — plugin's own docs
- `README.md` — root plugin index table

## Design Principles

1. **Project-agnostic** — auto-discover (`AGENTS.md`/`CLAUDE.md`, agents, docs dirs), ¬assume layout
2. **User is the gate** — present choices before destructive actions and wait for user reply
3. **Compressed notation** — use formal symbols where they cut tokens w/o losing semantics
4. **Append-only logs** — state-tracking plugins use append-only for auditability
5. **Recurrence detection** — if plugin solves recurring problems, track occurrences → root causes

## Data Management (invariants)

- **Default:** `~/.roxabi-vault/` — all user data, never in repo. Override: `ROXABI_VAULT_HOME`.
- `data.root` ∈ `plugin.json` must be unique across active plugins (enforced by `tools/validate_plugins.py`).
- **Zero personal data** ∈ repo — fictional only ∈ `examples/`. English names only.
- Active code and instructions MUST NOT import or execute archive content.
- Vault/indexing → [roxabi-vault](https://github.com/Roxabi/roxabi-vault).

→ [`docs/data-management.md`](docs/data-management.md) for the active `plugin.json` data format and storage rules.

## Editing Plugins (invariants)

- **Source of truth** = active repo source: `plugins/<plugin-name>/`. `archived/` is inert historical source, never an execution or installation target.
- **Never edit cache only** — changes lost on plugin update/reinstall.
- **Workflow:** edit an active catalogued plugin → commit + push → reinstall that plugin to refresh the local cache.
- **Versioning:** OMP catalogued plugins declare matching `package.json` and `.omp-plugin/marketplace.json` versions. Bump both together.

→ [`docs/plugin-cache.md`](docs/plugin-cache.md) — hash-keyed cache, `${CLAUDE_SKILL_DIR}` vs `${CLAUDE_PLUGIN_ROOT}`, re-install to refresh.

## Style

- Single quotes, no semicolons (any JS/TS ∈ plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands
- A test that forks a process MUST be named `*.integration.test.*` — 30s budget, not the 5s unit default (#502); `vitest.setup.ts` counts real forks and fails the build if one lands in `unit`
- Tests run without git's repo-location env (`vitest.setup.ts` strips `git rev-parse --local-env-vars`), so a hook's `GIT_DIR` cannot redirect a git fixture; a run that changes the repo's `core.bare` fails (`vitest.global-setup.ts`)
- A test's expected output is asserted, never printed. Under vitest a sync `exec*Sync` child given no `stdio` has its stderr piped (`vitest.setup.ts`): a failing call keeps it on the thrown error (`error.stderr`), a zero-exit call drops it, so a test that reads a succeeding child's stderr uses `spawnSync` or an explicit `stdio`. Code under test that writes to `process.stderr` or fd 1 directly is spied or mocked and the spy asserted

## Gotchas

- Cache ¬auto-updated after source edits — re-install the plugin (`claude plugin install <name>`). ¬rsync.
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` links ∈ SKILL.md = runtime-resolved, ¬render ∈ GitHub/VS Code previews
- **3rd-party plugin MCP servers** — external plugins (e.g. `knowledge-work-plugins/design`) may bundle `.mcp.json` w/ MCP servers (Slack, Figma, Linear, …) → auth warnings on startup. Disable w/o removing: empty `mcpServers` ∈ both `~/.claude/plugins/marketplaces/<marketplace>/<plugin>/.mcp.json` ∧ `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`, then `git update-index --skip-worktree <path>` ∈ marketplace repo → `git pull` won't restore them.
