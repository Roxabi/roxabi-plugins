# Project-Level Overrides

Let: α := agent | Ω := override file

Override any dev-core α or skill for a specific project w/o touching plugin source.

## Why override ¬configure?

`stack.yml` handles 95% of adaptation — paths, commands, framework names, standards.
Use Ω when changing **α behavior itself**, ¬config values:
- Add project-specific constraints ("¬`.$executeRaw` — use `db.query()` wrapper")
- Tighten escalation rules ("any migration needs lead approval")
- Add domain-specific checklist to skill phase
- Restrict α to codebase subset

## How it works

Claude Code resolves α definitions:

```
.claude/agents/<name>.md          ← project-level (highest priority)
~/.claude/agents/<name>.md        ← user-level
plugin cache (installed plugin)   ← lowest priority
```

Drop `.claude/agents/backend-dev.md` → **completely replaces** plugin version for that project.

## Agent Ω anatomy

Start from plugin α as base. Keep what works, add project-specific:

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

`# based-on:` comment documents source plugin version — useful when plugin α updated.

## Skill Ω anatomy

Skills at `.claude/skills/<skill-name>/SKILL.md`. Drop file → replaces plugin version:

```
.claude/skills/implement/SKILL.md     ← overrides dev-core's /implement skill
```

Same SKILL.md format. Copy plugin version as base, add project phases ∨ modify existing.

**Caution:** skills more complex to override — may call sub-agents + reference plugin cache files. Prefer appending phases (e.g., "Phase N — project-specific post-check") over modifying existing.

## Keep vs change

| Keep | Safe to change |
|------|---------------|
| `# based-on:` traceability (update value) | Escalation paths + thresholds |
| Phase 0 config guard | Boundaries (restrict further) |
| Base protocol (Communication, Research, Quality gates) | Edge cases (add project-specific) |
| Core workflow phases in skills | Standards refs (point to project docs) |

**¬remove** Phase 0 config guard — α hard-stop w/o it when `stack.yml` missing.

## When ¬override

- Different paths/commands only → `stack.yml`
- Add standards doc → point `standards.backend` etc. in `stack.yml`
- Stricter linting → update `build.formatter_config` in `stack.yml`

Ω = behavioral changes. Config changes → `stack.yml`.

## Keeping Ω current

Plugin α updates ¬auto-propagate to Ω. Diff updated plugin α vs Ω, merge improvements manually.

`# based-on:` tracks source version. Check drift: diff Ω vs plugin repo source (¬cache) — repo is canonical.
