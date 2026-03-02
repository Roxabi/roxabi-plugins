# dev-core Hooks

Claude Code hooks that run automatically on file writes and shell commands.

## What These Hooks Do

| Hook | Trigger | Action |
|------|---------|--------|
| `format.js` (PostToolUse) | After Edit or Write | Auto-formats `.ts/.tsx/.js/.jsx/.json` files with Biome |
| `security-check.js` (PreToolUse) | Before Edit or Write | Blocks hardcoded secrets, SQL/command injection patterns |
| `bun test` blocker (PreToolUse) | Before Bash | Blocks `bun test` (wrong runner), enforces `bun run test` |

## Defaults

These hooks default to **Bun + Biome**. If your project uses a different package manager or formatter, override them at the project level.

## Customizing Hooks

Claude Code hook resolution: project-level hooks (`.claude/hooks/hooks.json`) override plugin-level hooks.

To customize, copy `hooks.json` to your project's `.claude/hooks/hooks.json` and modify:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write $CLAUDE_FILE_PATHS"
          }
        ]
      }
    ]
  }
}
```

### Template: ESLint + Prettier

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"const p=process.env.CLAUDE_FILE_PATHS||'';const f=p.split('\\n').filter(x=>/\\.(ts|tsx|js|jsx)$/.test(x));if(f.length)require('child_process').execFileSync('npx',['eslint','--fix',...f],{stdio:'inherit'})\""
          }
        ]
      }
    ]
  }
}
```

### Template: No formatter

Remove the PostToolUse block entirely if you don't want auto-formatting.

## Validation

Run `/doctor` to verify that your hooks match your `stack.yml` formatter configuration. The doctor checks that the formatter referenced in `build.formatter_fix_cmd` matches the hooks that are active.

## Security Note

`format.js` reads `CLAUDE_FILE_PATHS` and splits it safely before passing paths as separate arguments to Biome. This avoids the shell injection risk of interpolating the env var directly in a shell command string.
