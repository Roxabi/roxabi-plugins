# Plan: Extract dev-core Plugin from roxabi_boilerplate

## Context

The Roxabi boilerplate has a complete AI-driven development workflow (20 skills, 9 agents, hooks) embedded in `.claude/`. The goal is to externalize the **core workflow** into a standalone plugin at `roxabi-plugins/plugins/dev-core/`, keeping it Roxabi-specific for now (genericization is a later pass).

This is Strategy 3 (hybrid): one big `dev-core` plugin with the full workflow, later complemented by standalone generic versions of individual skills.

## Scope

**Include (16 skills):**
- Orchestrator: `dev`
- Frame phase: `frame`
- Shape phase: `analyze`, `spec`, `interview`
- Build phase: `plan`, `implement`, `pr`
- Verify phase: `validate`, `review`, `fix`
- Ship phase: `promote`, `cleanup`
- Supporting: `test`, `issue-triage`, `adr`

**Include (9 agents):**
- Domain: `frontend-dev`, `backend-dev`, `devops`
- Quality: `tester`, `fixer`, `security-auditor`
- Strategy: `architect`, `product-lead`, `doc-writer`

**Include (3 hooks):**
- PreToolUse: `security-check.js` (Edit/Write)
- PreToolUse: bun-test-blocker (Bash)
- PostToolUse: biome-auto-format (Edit/Write)

**Exclude:**
- `agent-browser` (standalone tool, not workflow)
- `retro` (standalone analysis, not workflow)
- `issues` dashboard (standalone visualization)
- `compress`, `1b1` (already separate plugins in roxabi-plugins)

## Target Structure

```
roxabi-plugins/plugins/dev-core/
├── .claude-plugin/
│   └── plugin.json             # Plugin manifest (required for hooks)
├── README.md
├── skills/
│   ├── dev/SKILL.md
│   ├── frame/SKILL.md
│   ├── analyze/
│   │   ├── SKILL.md
│   │   └── references/expert-consultation.md
│   ├── spec/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── expert-consultation.md
│   │       ├── smart-splitting.md
│   │       └── templates.md
│   ├── interview/
│   │   ├── SKILL.md
│   │   └── references/templates.md
│   ├── plan/
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── edge-cases.md
│   │       └── micro-tasks.md
│   ├── implement/
│   │   ├── SKILL.md
│   │   └── references/edge-cases.md
│   ├── pr/SKILL.md
│   ├── review/SKILL.md
│   ├── fix/SKILL.md
│   ├── validate/SKILL.md
│   ├── cleanup/SKILL.md
│   ├── promote/
│   │   ├── SKILL.md
│   │   └── references/release-artifacts.md
│   ├── test/SKILL.md
│   ├── issue-triage/
│   │   ├── SKILL.md
│   │   ├── triage.ts
│   │   ├── lib/
│   │   │   ├── list.ts
│   │   │   ├── set.ts
│   │   │   └── create.ts
│   │   └── __tests__/
│   │       └── *.test.ts
│   └── adr/SKILL.md
├── agents/
│   ├── frontend-dev.md
│   ├── backend-dev.md
│   ├── devops.md
│   ├── tester.md
│   ├── fixer.md
│   ├── security-auditor.md
│   ├── architect.md
│   ├── product-lead.md
│   └── doc-writer.md
├── hooks/
│   ├── hooks.json              # Hook configuration (PreToolUse + PostToolUse)
│   └── security-check.js       # Security check script
└── references/
    ├── dev-process.md          # Extracted from CLAUDE.md: workflow rules, tier system
    └── team-coordination.md    # Extracted from AGENTS.md: agent roles, handoff protocol
```

## Implementation Steps

### Step 1: Create plugin manifest and directory structure

Create `.claude-plugin/plugin.json` (required for hooks to work):
```json
{
  "name": "dev-core",
  "description": "Full development workflow — frame, shape, plan, implement, review, ship. 16 skills, 9 agents, safety hooks.",
  "author": {
    "name": "Roxabi",
    "email": "dev@roxabi.com"
  }
}
```

Create all directories under `roxabi-plugins/plugins/dev-core/`.

### Step 2: Copy and adapt skills (16 skills)

For each skill in `/home/mickael/projects/roxabi_boilerplate/.claude/skills/`:

**Source → Destination mapping:**

| Source | Destination | Has references/ | Has scripts |
|--------|-------------|:---:|:---:|
| `.claude/skills/dev/SKILL.md` | `skills/dev/SKILL.md` | - | - |
| `.claude/skills/frame/SKILL.md` | `skills/frame/SKILL.md` | - | - |
| `.claude/skills/analyze/` | `skills/analyze/` | 1 ref | - |
| `.claude/skills/spec/` | `skills/spec/` | 3 refs | - |
| `.claude/skills/interview/` | `skills/interview/` | 1 ref | - |
| `.claude/skills/plan/` | `skills/plan/` | 2 refs | - |
| `.claude/skills/implement/` | `skills/implement/` | 1 ref | - |
| `.claude/skills/pr/SKILL.md` | `skills/pr/SKILL.md` | - | - |
| `.claude/skills/review/SKILL.md` | `skills/review/SKILL.md` | - | - |
| `.claude/skills/fix/SKILL.md` | `skills/fix/SKILL.md` | - | - |
| `.claude/skills/validate/SKILL.md` | `skills/validate/SKILL.md` | - | - |
| `.claude/skills/cleanup/SKILL.md` | `skills/cleanup/SKILL.md` | - | - |
| `.claude/skills/promote/` | `skills/promote/` | 1 ref | - |
| `.claude/skills/test/SKILL.md` | `skills/test/SKILL.md` | - | - |
| `.claude/skills/issue-triage/` | `skills/issue-triage/` | - | 4 TS files + tests |
| `.claude/skills/adr/SKILL.md` | `skills/adr/SKILL.md` | - | - |

**Adaptations needed per skill:**
- Ensure every SKILL.md has proper frontmatter: `name`, `description` (with `Triggers:`), `version: 0.1.0`, `allowed-tools`
- Update TS script paths in `issue-triage/SKILL.md` to use `${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts` instead of relative `.claude/skills/issue-triage/triage.ts`
- Skills that call other skills via `Skill` tool: keep short names (e.g., `skill: "frame"`) — Claude resolves these from installed skills, and within the same plugin there's no ambiguity

### Step 3: Copy and adapt agents (9 agents)

For each agent in `/home/mickael/projects/roxabi_boilerplate/.claude/agents/`:

**Copy all 9 `.md` files** to `agents/` directory.

**Adaptations needed:**
- Remove `memory: project` from frontmatter (agent memory is project-local, not plugin-portable)
- Keep `skills:` references to external plugins as-is (e.g., `frontend-design`, `context7-plugin:docs`) — users will need those plugins installed separately
- Keep `skills:` references to internal skills (e.g., `fix`, `test`, `interview`, `issue-triage`, `adr`) — these will resolve from the dev-core plugin
- Keep all other frontmatter (model, color, tools, permissionMode, maxTurns, disallowedTools)
- Agent system prompts: keep as-is (Roxabi-specific domain boundaries, file paths, etc.)

### Step 4: Create hooks configuration

Convert the 3 hooks from `.claude/settings.json` format to plugin `hooks/hooks.json` format.

**Source:** `.claude/settings.json` hooks section + `.claude/hooks/security-check.js`

**Target:** `hooks/hooks.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/security-check.js"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$CLAUDE_TOOL_INPUT\" | grep -qE '(^|\\s|&&|;|\\|)bun test(\\s|$)' && ! echo \"$CLAUDE_TOOL_INPUT\" | grep -qE 'bun run test'; then echo 'Use bun run test (Vitest), not bun test (Bun runner)' >&2; exit 2; fi"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$CLAUDE_FILE_PATHS\" | grep -qE '\\.(ts|tsx|js|jsx|json)$'; then timeout 10s bunx biome check --write \"$CLAUDE_FILE_PATHS\" || true; fi"
          }
        ]
      }
    ]
  }
}
```

**Copy** `security-check.js` to `hooks/security-check.js`. Adapt the state file path: currently writes to `.claude/security_warnings/` — update to use a path relative to the project (keep `.claude/security_warnings/` as convention, or use `${CLAUDE_PLUGIN_ROOT}/.state/`).

**Decision:** Keep `.claude/security_warnings/` as the state path — it's project-local state, not plugin state. The hook runs in the project context so this works.

### Step 5: Create plugin references

Extract workflow governance docs from the boilerplate into plugin references:

**`references/dev-process.md`** — Extract from `CLAUDE.md`:
- Tier system (S / F-lite / F-full)
- Workflow phases and step ordering
- Artifact model and paths
- Git workflow rules (worktree, commit format, branch naming)
- Quality gate requirements
- Mandatory rules (AskUserQuestion, no force/amend, etc.)

**`references/team-coordination.md`** — Extract from `AGENTS.md`:
- Team structure (domain, quality, strategy)
- 4-phase workflow
- Task lifecycle and handoff format
- Domain boundaries per agent
- Micro-task protocol
- Spawning rules (parallel limits, RED-GATE)

These reference files will be loaded by skills that need them (dev orchestrator, implement, review, fix).

### Step 6: Register in marketplace

**Update `.claude-plugin/marketplace.json`:**
```json
{
  "name": "dev-core",
  "description": "Full development workflow — frame, shape, plan, implement, review, ship. Opinionated Roxabi process with 16 skills, 9 agents, and safety hooks.",
  "source": "./plugins/dev-core",
  "category": "development"
}
```

**Update root `README.md`:** Add dev-core to the plugins table.

### Step 7: Write plugin README

Create `plugins/dev-core/README.md` covering:
- What it does (full dev lifecycle orchestrator)
- Prerequisites (Bun, GitHub CLI, Biome, the Roxabi monorepo stack)
- How to install
- How to use (`/dev #N` as entry point)
- Skill list with one-liner descriptions
- Agent team overview
- Hooks overview
- External plugin dependencies (frontend-design, ui-ux-pro-max, context7-plugin)

### Step 8: Verify

- Check all SKILL.md files have valid frontmatter
- Check all agent .md files have valid frontmatter
- Check hooks.json is valid JSON
- Check all reference file paths exist
- Verify issue-triage TS scripts are present and paths updated
- Run `claude plugin validate .` from roxabi-plugins root (if available)

## Key Decisions

1. **`.claude-plugin/plugin.json` required** — Plugins with hooks need a manifest. All official plugins (security-guidance, hookify, etc.) have one. Minimal: name + description + author.
2. **Agent memory excluded** — Agent memory (`.claude/agent-memory/`) is project-specific state. Not part of the plugin. Users keep their own memory.
3. **External plugin deps documented, not enforced** — Agents reference `frontend-design`, `ui-ux-pro-max`, `context7-plugin`. These are documented in README as "recommended companion plugins" since there's no dependency system yet.
4. **Issue-triage scripts bundled** — The 4 TS files + tests ship with the plugin. SKILL.md references them via `${CLAUDE_PLUGIN_ROOT}`.
5. **Keep Roxabi-specific content** — All hardcoded values (bun, staging, artifacts/, Biome, etc.) stay as-is. Genericization is a separate future task.
6. **Skill cross-references use short names** — `skill: "frame"` not `skill: "dev-core:frame"`. Claude resolves these from installed skills.

## Files Modified in roxabi-plugins

**New files (~42 files):**
- `plugins/dev-core/.claude-plugin/plugin.json`
- `plugins/dev-core/README.md`
- `plugins/dev-core/skills/*/SKILL.md` (16 skills)
- `plugins/dev-core/skills/*/references/*.md` (8 reference files)
- `plugins/dev-core/skills/issue-triage/{triage.ts, lib/*.ts, __tests__/*.ts}` (~7 TS files)
- `plugins/dev-core/agents/*.md` (9 agents)
- `plugins/dev-core/hooks/hooks.json`
- `plugins/dev-core/hooks/security-check.js`
- `plugins/dev-core/references/dev-process.md`
- `plugins/dev-core/references/team-coordination.md`

**Modified files:**
- `.claude-plugin/marketplace.json` — add dev-core entry
- `README.md` — add dev-core to plugins table
