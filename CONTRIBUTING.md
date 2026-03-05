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

- Always include `Co-Authored-By` when pair-programming with Claude
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
