# dev-core Hooks

Claude Code hooks that run automatically on file writes and shell commands.

## What These Hooks Do

| Hook | Trigger | Action |
|------|---------|--------|
| `format.js` (PostToolUse) | After Edit or Write | Auto-formats files using `build.formatter_fix_cmd` from `stack.yml` |
| `security-check.js` (PreToolUse) | Before Edit or Write | Blocks hardcoded secrets, SQL/command injection patterns |
| `bun test` blocker (PreToolUse) | Before Bash | Blocks `bun test` (wrong runner), enforces `bun run test` |

## How `format.js` Works

`format.js` reads `build.formatter_fix_cmd` from `.claude/stack.yml` at runtime:

- **Empty / key absent** → exits silently, no formatting applied
- **Set** → runs the command with the modified file paths appended as arguments

```
stack.yml: formatter_fix_cmd: "bunx biome check --write"

Edit foo.ts, bar.ts
  → format.js
  → execFileSync('bunx', ['biome', 'check', '--write', 'foo.ts', 'bar.ts'])
```

File paths are passed as separate `execFileSync` arguments — no shell interpolation, no injection risk.

Formatting errors are **non-fatal**: if the formatter exits non-zero, the hook exits 0 so the write is never blocked.

## Configuring Your Formatter

Set `build.formatter_fix_cmd` in `.claude/stack.yml`. Leave it empty to disable auto-formatting.

### Bun + Biome (default)

```yaml
build:
  formatter_fix_cmd: "bunx biome check --write"
```

### Node + Prettier

```yaml
build:
  formatter_fix_cmd: "npx prettier --write"
```

### Python + Ruff

```yaml
build:
  formatter_fix_cmd: "ruff format"
```

### Python + Black

```yaml
build:
  formatter_fix_cmd: "black"
```

### Node + ESLint (fix only)

```yaml
build:
  formatter_fix_cmd: "npx eslint --fix"
```

### Disabled

```yaml
build:
  formatter_fix_cmd:   # empty → hook skips silently
```

## Supported File Extensions

The hook filters to extensions that formatters typically handle before calling the command:

`.ts` `.tsx` `.js` `.jsx` `.cjs` `.mjs` `.json` `.jsonc` `.py` `.rb` `.go` `.rs` `.css` `.scss` `.less` `.html` `.svelte` `.vue` `.md` `.mdx`

The formatter itself decides which extensions it actually processes — unrecognised files are typically skipped by the tool.

## Project-Level Overrides

Plugin-level hooks can be overridden per-project. Create `.claude/hooks/hooks.json` in your project root — it takes precedence over the plugin's `hooks.json`.

Use this to customise the `bun test` blocker or add project-specific hooks.

## Validation

Run `/doctor` to verify that your active hooks match your `stack.yml` formatter configuration.

## Security Note

`format.js` reads `CLAUDE_FILE_PATHS`, splits it safely, and passes paths as discrete `execFileSync` arguments. The formatter command from `stack.yml` is split on whitespace into argv — no shell expansion, no injection surface.
