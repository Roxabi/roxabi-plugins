# Plugin Cache

**Source of truth** is always the repo: `plugins/<plugin-name>/` in this repository.

The installed (running) copies live in the plugin cache at:

```
~/.claude/plugins/cache/roxabi-marketplace/<plugin-name>/<hash>/
```

These are independent copies — editing one does not update the other.

## How the cache works

Each project that has a plugin installed uses a specific cache dir identified by a hash (e.g. `6011eb380f4f`). Multiple projects can have different hashes for the same plugin, and old hashes accumulate over time.

**Editing the source never touches the cache automatically.**

## Workflow

1. **Edit the repo source first** — `plugins/<plugin-name>/skills/...`, `plugins/<plugin-name>/agents/...`, etc.
2. **Commit and push.**
3. **Refresh the local cache** — re-install the plugin from the marketplace:

   ```bash
   claude plugin install <plugin-name>
   ```

   This pulls the marketplace clone and repopulates the hash-keyed cache dir for every project that uses the plugin.

## Skill path variables

These are substituted at skill load time by Claude Code (not shell env vars):

- `${CLAUDE_SKILL_DIR}` — resolves to the skill's own directory (e.g. `…/plugins/dev-core/skills/implement`)
- `${CLAUDE_PLUGIN_ROOT}` — resolves to the plugin root in the **marketplace clone** (e.g. `~/.claude/plugins/marketplaces/roxabi-marketplace/plugins/dev-core`)

- Use `${CLAUDE_PLUGIN_ROOT}` for cross-skill references within the same plugin (e.g. `${CLAUDE_PLUGIN_ROOT}/skills/shared/references/`).
- Use `${CLAUDE_PLUGIN_ROOT}/../shared/` to reference cross-plugin shared files in `plugins/shared/` (e.g. the decision protocol).

## Rules

- **Never edit only the cache** — changes are lost on plugin update/reinstall
- **Always commit repo source** — the cache is ephemeral, the repo is permanent
- **Re-install the plugin after every push** — so projects pick up the latest version
