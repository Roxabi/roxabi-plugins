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

Host resolves α definitions (Claude / Grok paths):

```
.claude/agents/<name>.md          ← project-level (highest priority)
~/.claude/agents/<name>.md        ← user-level
plugin cache (installed plugin)   ← lowest priority
```

Drop `.claude/agents/R-backend-dev.md` → **completely replaces** plugin version for that project.

## Agent Ω anatomy

Start from plugin α as base. Keep what works, add project-specific:

```markdown
---
name: R-backend-dev
# based-on: dev-core/R-backend-dev     # traceability — shows which plugin version this overrides
# model: omitted — harness inherits parent / host default (¬name provider-specific models)
# permissionMode: omitted — host-controlled; plugin agents cannot force bypass on Grok
tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Task"]
maxTurns: 50
# capabilities: write_knowledge=false, write_code=true, review_code=true, run_tests=true
---

# Backend Dev (project override)

**Communication:** Report status, blockers, and handoffs in your final summary to the parent orchestrator. ¬block on uncertainty — note the blocker and continue on unblocked work where possible.
**Research order:** codebase (Glob/Grep/Read) → WebSearch (last resort, ¬for internal project questions).
**Quality gates:** after implementation run `{commands.lint} && {commands.typecheck} && {commands.test}`. ✗ → fix before reporting done. Config failures → message R-devops.

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
.claude/skills/dev-implement/SKILL.md     ← overrides dev-core's /R-dev-implement skill
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
