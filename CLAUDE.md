@.claude/stack.yml

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
- **Workflow:** edit repo source → commit + push → re-install via `claude plugin install <plugin-name>` to refresh local cache.
- **Versioning** ([docs](https://code.claude.com/docs/en/plugin-marketplaces#version-resolution-and-release-channels)): resolution order = `plugin.json.version` > marketplace entry `version` > git commit SHA (first set wins). **Default policy: omit `version` from `plugin.json`** → every commit auto-ships as a new version (SHA-based, zero discipline). Set `version` only on semver-disciplined plugins (e.g., `dev-core`); bump on every release or users will not receive updates. Never set in both `plugin.json` AND marketplace entry — `plugin.json` silently wins, masking the marketplace value.

- **Shared-source TS files** — four governance mechanisms; choice depends on whether the file ships at runtime and which effort owns it. Full scope recorded in [ADR-014](docs/architecture/adr/014-shared-ts-governance-scope.mdx).
  - **Copy-sync** (runtime files) — dev-core canonical byte-copied into dev-init by `bun run sync:shared`; copies carry `// @generated` header, byte-equality-gated by `tools/validate_plugins.py --check shared-sources-sync` (CI + lefthook). Manifest: `tools/shared-sources.json`. ¬hand-edit copies — edit dev-core canonical only. Currently 14 files: `config-helpers.ts`, `domain/errors.ts`, `domain/types.ts`, `adapters/env-config.ts`, `adapters/workspace-store.ts`, `ports/artifacts.ts`, `ports/config.ts`, `prereqs.ts`, `queries.ts`, `types.ts` (#232), `adapters/github-infra.ts`, `domain/parse-issue-ref.ts`, `ports/workspace.ts` (#240), `adapters/github-adapter.ts` (#268, ADR-015). The `biome.json overrides[0].includes` suppression list is **derived from `tools/shared-sources.json`** (SSoT, set-equality assertion) — broad glob was rejected (would silently un-lint genuinely hand-written files). A header-contract comment in both `tools/sync-shared.ts::makeHeader` and `tools/validate_plugins.py::check_shared_sources_sync` asserts the 2-line strip stays in lockstep.
  - **Shared-import** (test-only logic) — single file under `plugins/shared/__tests__/` imported directly via relative path by both plugins' test files. No copy, no `@generated` header, no sync gate. Currently: `detect-github-repo.suite.ts` (the `detectGitHubRepo`/`gh_project_id` suite factory). 6 test pairs slated to convert (deferred #239): `github.test.ts`, `parse-issue-ref.test.ts`, `prereqs.test.ts`, `priority-labels.test.ts`, `resolveFieldIds.test.ts`, `resolveSize-legacy-schema.test.ts`.
  - **Caller-parity** (test boilerplate) — `__tests__/config.test.ts` is **not** copy-synced (a `@generated` header would break the parity check). Its two copies are kept byte-identical by hand + a CI `diff` gate ("caller parity #218 SC3", owned by #218/#225). Edit both in lockstep.
  - **Intentional-fork** — none. `adapters/github-adapter.ts`'s +272-line `GitHubAdapter` class was removed and the file rejoined copy-sync in #268 ([ADR-015](docs/architecture/adr/015-direct-call-over-role-interface-ports-typescript.mdx)).
  - **Leave-alone-pending-reconciliation** — none remaining. `github-infra.ts`/`parse-issue-ref.ts`/`ports/workspace.ts` are copy-sync (manifest); `__tests__/domain.test.ts`'s `IssuePort`/`ProjectPort` fork was removed in #268.
  - **Selection rule:** runtime source (ships with installed plugin) → copy-sync (cross-plugin runtime imports forbidden by marketplace self-containment). Test-only logic → shared-import. Thin test boilerplate that must stay byte-identical (so it cannot carry a header) → caller-parity diff gate.

→ [`docs/plugin-cache.md`](docs/plugin-cache.md) — how the hash-keyed cache works, `${CLAUDE_SKILL_DIR}` vs `${CLAUDE_PLUGIN_ROOT}`, sync script details.

## Style

- Single quotes, no semicolons (any JS/TS ∈ plugins)
- Markdown: ATX headings (`#`), tables for structured data, code blocks for commands

## Gotchas

- Always run rsync sync script after editing plugin source — cache ¬auto-updated
- `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` links ∈ SKILL.md = runtime-resolved, ¬render ∈ GitHub/VS Code previews
- **3rd-party plugin MCP servers** — external plugins (e.g. `knowledge-work-plugins/design`) may bundle `.mcp.json` w/ MCP servers (Slack, Figma, Linear, …) → auth warnings on startup. Disable w/o removing: empty `mcpServers` ∈ both `~/.claude/plugins/marketplaces/<marketplace>/<plugin>/.mcp.json` ∧ `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`, then `git update-index --skip-worktree <path>` ∈ marketplace repo → `git pull` won't restore them.
