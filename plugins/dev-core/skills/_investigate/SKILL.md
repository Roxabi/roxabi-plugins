---
name: _investigate
description: 'Temporary investigation skill — plugin system internals. Triggers: "roxabi investigate" | "run investigate skill".'
version: 0.1.0
allowed-tools: Bash
---

# Investigation 1 — @ include syntax

@/tmp/test-include.md

If you saw "INCLUDE_RESOLVED" above this line, report: **@ includes work in SKILL.md**.
If the line above is literally `@/tmp/test-include.md`, report: **@ includes do NOT work**.

# Investigation 2a — Template variables (substituted at load time)

Report whether each of these resolved to a real path or appears literally as `${VAR_NAME}`:

- CLAUDE_PLUGIN_ROOT = ${CLAUDE_PLUGIN_ROOT}
- CLAUDE_SKILL_DIR = ${CLAUDE_SKILL_DIR}
- CLAUDE_MARKETPLACE_ROOT = ${CLAUDE_MARKETPLACE_ROOT}
- CLAUDE_PLUGINS_ROOT = ${CLAUDE_PLUGINS_ROOT}
- CLAUDE_PLUGINS_DIR = ${CLAUDE_PLUGINS_DIR}

# Investigation 2b — Shell environment variables (at Bash runtime)

Run each echo and report the output (empty = variable does not exist as shell env var):

```bash
echo "PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
echo "SKILL_DIR=$CLAUDE_SKILL_DIR"
echo "MARKETPLACE_ROOT=$CLAUDE_MARKETPLACE_ROOT"
echo "PLUGINS_ROOT=$CLAUDE_PLUGINS_ROOT"
echo "PLUGINS_DIR=$CLAUDE_PLUGINS_DIR"
```

Present all results as a single table:

| Variable | Template value (2a) | Shell value (2b) |
|----------|--------------------|--------------------|
| CLAUDE_PLUGIN_ROOT | ? | ? |
| CLAUDE_SKILL_DIR | ? | ? |
| CLAUDE_MARKETPLACE_ROOT | ? | ? |
| CLAUDE_PLUGINS_ROOT | ? | ? |
| CLAUDE_PLUGINS_DIR | ? | ? |

$ARGUMENTS
