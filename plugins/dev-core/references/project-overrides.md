# Project-Level Overrides

Override any dev-core agent or skill for a specific project without touching the plugin source.

## Why override instead of configure?

`stack.yml` handles 95% of project adaptation — paths, commands, framework names, standards docs.
Use overrides when you need to **change agent behavior itself**, not just its config values:

- Add project-specific constraints ("never use Prisma `.$executeRaw` — use the `db.query()` wrapper instead")
- Tighten escalation rules ("any DB migration needs lead approval, not just conflicts")
- Add a domain-specific checklist to a skill phase
- Restrict an agent to a subset of the codebase

## How it works

Claude Code resolves agent definitions in this order:

```
.claude/agents/<name>.md          ← project-level (highest priority)
~/.claude/agents/<name>.md        ← user-level
plugin cache (installed plugin)   ← lowest priority
```

Drop a file at `.claude/agents/backend-dev.md` and it **completely replaces** the plugin version for that project.

## Agent override anatomy

Start from the plugin's agent as a base. Keep what works, add what's project-specific:

```markdown
---
name: backend-dev
# based-on: dev-core/backend-dev     # traceability — shows which plugin version this overrides
model: sonnet
color: white
tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Task", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "SendMessage"]
permissionMode: bypassPermissions   # ⚠ removes all confirmation dialogs — review before use
maxTurns: 50
# capabilities: write_knowledge=false, write_code=true, review_code=true, run_tests=true
---

# Backend Dev (project override)

**Communication:** use SendMessage to reach teammates (¬plain text). ¬block on uncertainty — message and continue.
**Research order:** codebase (Glob/Grep/Read) → context7 → WebSearch (last resort).
**Quality gates:** after implementation run `{commands.lint} && {commands.typecheck} && {commands.test}`. ✗ → fix before reporting done. Config failures → message devops.

If `{backend.path}` is undefined → output: "`.claude/stack.yml` not found."

<!-- all plugin content -->

## Project Constraints

- ¬`db.$executeRaw` — use `db.query()` wrapper in `{backend.path}/lib/db.ts`
- DB migration → message lead before applying (¬apply in agent turn)
- ¬`any` in new service methods — use `{shared.types}/` or create a new type
```

The `# based-on:` comment documents which plugin version the override derives from — useful for maintainers when plugin agents are updated.

## Skill override anatomy

Skills live at `.claude/skills/<skill-name>/SKILL.md`. Drop a file there to replace the plugin's version:

```
.claude/skills/implement/SKILL.md     ← overrides dev-core's /implement skill
```

Skill overrides follow the same SKILL.md format as plugin skills. Copy the plugin version as a starting point and add your project phases or modify existing ones.

**Caution:** skills are more complex to override than agents — they may call sub-agents and reference other files in the plugin cache. Prefer adding phases at the end (e.g., "Phase N — project-specific post-check") over modifying existing ones.

## What to keep vs change

| Keep | Safe to change |
|------|---------------|
| `# based-on:` traceability comment (update value) | Escalation paths and thresholds |
| Phase 0 config guard | Boundaries (restrict further) |
| Base protocol lines (Communication, Research order, Quality gates) | Edge cases (add project-specific entries) |
| Core workflow phases in skills | Standards references (point to project docs) |

**Never remove** the Phase 0 config guard — agents hard-stop without it when `stack.yml` is missing.

## When not to override

- You only need different paths or commands → use `stack.yml`
- You want to add a standards doc → point `standards.backend` etc. to your doc in `stack.yml`
- You want stricter linting → update `build.formatter_config` in `stack.yml`

Overrides are for behavioral changes. Configuration changes belong in `stack.yml`.

## Keeping overrides up to date

When dev-core agents are updated in a new plugin version, your overrides won't automatically pick up the changes. Diff the updated plugin agent against your override and merge relevant improvements manually.

Use the `# based-on:` comment to track which plugin version the override was based on. To check for drift, diff your override file against the plugin repo source (not the cache) — the repo is the canonical version.
