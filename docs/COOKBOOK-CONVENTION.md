# Cookbook & Playbook Convention

Standard locations and naming for procedural guides in Roxabi ecosystem.

---

## Definitions

| Type | Purpose | Scope |
|------|---------|-------|
| **Cookbook** | Procedural guide — recipes, steps, patterns | Reusable across projects |
| **Playbook** | Scenario guide — specific workflow, narrative | Project or task-specific |
| **Reference** | Lookup table — rules, constraints, options | Skill-adjacent lookup |

---

## Location Convention

### Cookbooks

```
roxabi-plugins/plugins/shared/cookbooks/    # Cross-project, reusable
  first-principles.md
  error-recovery.md
  ...

roxabi-plugins/plugins/<plugin>/cookbooks/   # Plugin-specific
  dev-core/skills/checkup/cookbooks/
    devcore-checks.md
    infra-checks.md
  ci-setup/cookbooks/
    ...
```

**Rule:** Cookbook that applies to >1 plugin → `shared/cookbooks/`

### Playbooks

```
roxabi-plugins/playbooks/                    # Centralized
  codebase-documentation-playbook.md
  BRAND-EXPLORATION-PLAYBOOK.md
  ...

<project>/docs/playbooks/                    # Project-specific
  QWEN35-27B-TURBOQUANT-SETUP.md
  ...
```

**Rule:** Playbooks are narrative workflows — centralized unless project-specific.

### References

```
roxabi-plugins/plugins/<plugin>/references/  # Plugin-level refs
roxabi-plugins/plugins/<plugin>/skills/<skill>/references/  # Skill-level refs
```

**Rule:** References live adjacent to the skill that consumes them.

---

## Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Cookbook | `{topic}.md` | `first-principles.md`, `error-recovery.md` |
| Playbook | `{TOPIC}-PLAYBOOK.md` | `AVATAR-PLAYBOOK.md` |
| Reference | `{topic}.md` | `templates.md`, `edge-cases.md` |

---

## Access Patterns

### From skills (runtime)

```markdown
Read [references/templates.md](${CLAUDE_SKILL_DIR}/references/templates.md)
```

### From cookbooks (cross-plugin)

```markdown
Read [first-principles.md](${CLAUDE_PLUGIN_ROOT}/../shared/cookbooks/first-principles.md)
```

### From playbooks (centralized)

```markdown
Read [AVATAR-PLAYBOOK.md](~/projects/roxabi-plugins/playbooks/AVATAR-PLAYBOOK.md)
```

---

## Migration Checklist

When adding a new cookbook/playbook:

1. **Determine scope:** Cross-project? → `shared/cookbooks/` | Plugin-specific? → `plugins/<name>/cookbooks/`
2. **Check naming:** Cookbook = `{topic}.md` | Playbook = `{TOPIC}-PLAYBOOK.md`
3. **Add to index:** Update this doc's examples if new category
4. **Link from consumer:** Add reference in skills/CLAUDE.md that use it

---

## Current Inventory

### Shared Cookbooks (`plugins/shared/cookbooks/`)

| File | Description |
|------|-------------|
| `first-principles.md` | 8 recipes for AI code dev (intent, decomposition, verification) |
| `musk-algorithm.md` | 5-step anti-bureaucracy algorithm (question → delete → simplify → accelerate → automate) |

### Plugin Cookbooks (`plugins/*/cookbooks/`)

| Plugin | Cookbooks |
|--------|-----------|
| `dev-core/checkup` | `devcore-checks.md`, `infra-checks.md`, `stack-checks.md` |
| `dev-core/ci-setup` | `marketplace.md`, `scanning.md`, `workflows.md`, `hooks.md` |
| `dev-core/cleanup-context` | `analysis.md`, `discovery.md`, `resolution.md` |
| `dev-core/release-setup` | `quality-gates.md`, `release-automation.md`, `commit-standards.md`, `hook-runner.md` |

### Playbooks (`roxabi-plugins/playbooks/`)

| File | Description |
|------|-------------|
| `codebase-documentation-playbook.md` | Docs workflow |
| `BRAND-EXPLORATION-PLAYBOOK.md` | Brand discovery |
| `MEETING-REGEN-PLAYBOOK.md` | Meeting notes regen |
| `syncthing-agent-sync-playbook.md` | Sync setup |
| `AVATAR-PLAYBOOK.md` | Avatar pipeline overview |
| `AVATAR-PIPELINES.md` | Pipeline details |
| `AVATAR-LESSONS.md` | Lessons learned |
| `AVATAR-LOG.md` | Log entries |
| `VIDEO-VOICE-PLAYBOOK.md` | Video analyze → voice clone → render pipeline |

---

## See Also

- `roxabi-plugins/plugins/shared/references/` — shared reference files
- `~/.roxabi/forge/` — forge diagrams (visual artifacts, not cookbooks)
