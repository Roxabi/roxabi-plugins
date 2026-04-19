# Contributing

## Workflow

```
feature/fix branch → PR → staging → (promote) → main
```

1. Create a branch from `staging`: `feat/plugins/new-skill`, `fix/plugins/compress-edge-case`
2. Open a PR targeting `staging`
3. Pass CI (`bun lint`, `bun typecheck`, `bun test`)
4. Merge

## Creating a new plugin

1. **Create directory:** `mkdir -p plugins/<name>/skills/<skill-name>`
2. **Write SKILL.md** with YAML frontmatter (`name`, `description`, `version`, `allowed-tools`) + instructions body
3. **Write README.md** for the plugin (what, install, usage, how it works)
4. **Register** in `.claude-plugin/marketplace.json`
5. **Add row** to the Plugins table in root `README.md`
6. **Validate and commit:**
   ```bash
   claude plugin validate .
   bun lint && bun typecheck && bun test
   ```

See `CLAUDE.md` for full details on each step.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(plugins): add voice-me — TTS script authoring skill
fix(compress): handle nested code blocks
chore: bump biome to 2.0
docs(plugins): update compress README
```

- Scope: `plugins`, or a specific plugin name (`compress`, `vault`, `voice-me`)

## PR conventions

- Title = Conventional Commits format
- Link the issue: `Closes #N`
- One plugin or one logical change per PR
- CI must be green before merge

## Code style

```bash
bun run lint              # Biome lint — must pass
bun run typecheck         # TypeScript — must pass
bun run test              # Vitest — must pass
```

Style: single quotes, no semicolons. Markdown: ATX headings, tables for structured data.

## Project structure

```
plugins/
  <plugin-name>/
    README.md             — human-readable docs
    skills/<skill>/SKILL.md — skill definition (frontmatter + instructions)
    agents/               — (optional) agent definitions
    commands/             — (optional) slash commands
.claude-plugin/
  marketplace.json        — marketplace manifest
```

Source of truth is always this repo. Installed cache copies are ephemeral.

## Upstream sync

Wrapped plugins and curated marketplaces drift over time. Run this process periodically (or when CI opens an `upstream-update` issue).

### 1. Check curated marketplaces for drift

For each entry in `external-registry.json` → `curated_marketplaces`:

```bash
# Compare stored SHA against upstream HEAD
git ls-remote <source>.git refs/heads/<branch> | awk '{print $1}'
```

If the SHA differs from `last_checked_commit`:
- Fetch the changelog: `gh api repos/<owner>/<repo>/compare/<old_sha>...<branch>`
- Review commits for breaking changes (renamed skills, removed files, new dependencies)
- Update `last_checked_commit` in `external-registry.json`

### 2. Check wrapped plugins for content changes

For each entry in `wrapped_plugins`:

```bash
# Clone upstream shallow
git clone --depth 1 <upstream_url> /tmp/<name>-upstream

# Diff file trees (our references/ layout vs upstream flat layout)
diff <(cd /tmp/<name>-upstream/<path> && find . -type f | sort) \
     <(cd plugins/<name>/skills/<skill>/references && find . -type f | sort)

# Diff content of matching files
diff /tmp/<name>-upstream/<path>/rules/<file>.md \
     plugins/<name>/skills/<skill>/references/rules/<file>.md
```

- **New files upstream** → copy into `references/`
- **Changed content** → review and merge (our frontmatter is intentionally different — skip those diffs)
- Update `last_sync_commit` and `last_sync_date` in `external-registry.json`

### 3. Check if wrapped plugins should be promoted

For each wrapped plugin, check if upstream now ships a proper marketplace:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/contents/.claude-plugin" | jq '.[].name'
```

If upstream has `.claude-plugin/marketplace.json` with versioned plugins → **promote to curated**:

1. `git rm -r plugins/<name>/`
2. Remove from `.claude-plugin/marketplace.json`
3. Add to `curated_marketplaces` in `external-registry.json`
4. Add to `.claude-plugin/curated-marketplaces.json`
5. Move to endorsed marketplaces table in `README.md`

### 4. Consistency check

Verify all registry files agree:

- `external-registry.json` curated names == `curated-marketplaces.json` marketplace names
- All `marketplace.json` sources point to existing directories on disk
- No orphan directories in `plugins/` missing from `marketplace.json`
- All endorsed marketplaces listed in `README.md`

### 5. Commit and push

One commit per logical change, conventional commit format. Examples:

```
chore(plugins): sync upstream — 6 new react rules + register wrapped plugins
refactor(plugins): promote visual-explainer to curated marketplace
fix(registry): add missing entry to curated-marketplaces
```
