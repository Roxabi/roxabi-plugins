---
name: test
description: 'Investigation test skill. Triggers: "roxabi investigation" | "run investigation skill".'
version: 0.1.0
allowed-tools: Bash
---

# Investigation 1 — @ include

@/tmp/test-include.md

If you saw "INCLUDE_RESOLVED" above this line, @ includes work in SKILL.md.

# Investigation 2a — Template variables (substituted at load time)

CLAUDE_PLUGIN_ROOT = ${CLAUDE_PLUGIN_ROOT}
CLAUDE_SKILL_DIR = ${CLAUDE_SKILL_DIR}
CLAUDE_MARKETPLACE_ROOT = ${CLAUDE_MARKETPLACE_ROOT}
CLAUDE_PLUGINS_ROOT = ${CLAUDE_PLUGINS_ROOT}
CLAUDE_PLUGINS_DIR = ${CLAUDE_PLUGINS_DIR}

For each variable above: report whether it resolved to a path or appears literally as `${VAR_NAME}`.

# Investigation 2b — Shell environment variables (resolved at Bash runtime)

Run each of these and report the output:

```
echo "PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
echo "SKILL_DIR=$CLAUDE_SKILL_DIR"
echo "MARKETPLACE_ROOT=$CLAUDE_MARKETPLACE_ROOT"
echo "PLUGINS_ROOT=$CLAUDE_PLUGINS_ROOT"
echo "PLUGINS_DIR=$CLAUDE_PLUGINS_DIR"
```

Report results as a table: Variable | Template value | Shell value

$ARGUMENTS
