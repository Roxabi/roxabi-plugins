# dev-core

Full development lifecycle orchestrator for Roxabi projects. Covers framing, analysis, specification, planning, implementation, review, and shipping. Opinionated workflow with 20 skills, 9 specialized agents, and safety hooks.

## Prerequisites

- [Bun](https://bun.sh/) -- package manager and runtime
- [GitHub CLI](https://cli.github.com/) (`gh`) -- issue fetching, PR creation, label management
- [Biome](https://biomejs.dev/) -- used by the auto-format hook for TS/JS/JSON files

## Install

Add the Roxabi marketplace (if not already added):

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
```

Install the plugin:

```bash
claude plugin install dev-core
```

## Getting Started

After installing, run the init skill to configure your project:

```
/init
```

This auto-detects your GitHub repo, Project V2 board, and field IDs, then writes `.env`, sets up the dashboard script in `package.json`, and creates the `artifacts/` directory. Re-run with `/init --force` to reconfigure.

**Important:** `/init` is required for project board features (issue status, size, priority fields). Without it, issue creation and dependency management still work, but field updates will show a "not configured" error pointing back to `/init`.

## Usage

The main entry point is:

```
/dev #N
```

Where `#N` is a GitHub issue number. The orchestrator scans existing artifacts, determines the issue tier (S / F-lite / F-full), shows current progress, and delegates to the right phase skill. It drives the full lifecycle from issue to merged PR.

## Skills

19 skills organized by workflow phase:

| Skill | Phase | Description |
|-------|-------|-------------|
| `init` | Setup | Configures project for dev-core (GitHub Project V2, labels, workflows, branch protection, env vars). TypeScript CLI with subcommands, SKILL.md orchestrates via AskUserQuestion |
| `doctor` | Setup | Health check — verifies prerequisites, GitHub config, labels, workflows, branch protection, project structure. Standalone TypeScript CLI |
| `dev` | Orchestrator | Routes issues through the full workflow |
| `frame` | Frame | Creates initial feature frame from issue |
| `analyze` | Shape | Deep analysis with expert consultation |
| `spec` | Shape | Generates specifications with smart splitting |
| `interview` | Shape | Interactive requirements gathering |
| `plan` | Build | Creates implementation plan with micro-tasks |
| `implement` | Build | Executes implementation from plan |
| `pr` | Build | Creates pull request with proper format |
| `review` | Verify | Code review against quality gates |
| `fix` | Verify | Applies fixes from review feedback |
| `validate` | Verify | Validates implementation against spec |
| `cleanup` | Ship | Post-merge cleanup |
| `promote` | Ship | Promotes to staging/production |
| `test` | Supporting | Runs and manages tests |
| `issues` | Supporting | Lists/dashboards GitHub issues — status, dependencies, backlog |
| `issue-triage` | Supporting | Triages GitHub issues with labels/priority |
| `adr` | Supporting | Creates Architecture Decision Records |
| `doc-sync` | Supporting | Syncs CLAUDE.md, README.md, and plugin SKILL.md after a code change |

## Agents

9 specialized agents organized in three tiers:

### Domain

| Agent | Role |
|-------|------|
| `frontend-dev` | Frontend implementation (`apps/web/`, `packages/ui/`) |
| `backend-dev` | Backend implementation (`apps/api/`, `packages/types/`) |
| `devops` | Infrastructure, CI/CD, root configs |

### Quality

| Agent | Role |
|-------|------|
| `tester` | Writes and runs tests, manages RED-GATE |
| `fixer` | Applies accepted review findings |
| `security-auditor` | OWASP Top 10 audit with exploit scenarios, confidence scoring (C ≥ 60), and false-positive filtering |

### Strategy

| Agent | Role |
|-------|------|
| `architect` | Architecture decisions, ADRs |
| `product-lead` | Analysis, specifications, issue management |
| `doc-writer` | Documentation across all docs directories |

## Hooks

Three Claude Code hooks for safety and consistency:

| Hook | Trigger | What it does |
|------|---------|--------------|
| Security check | PreToolUse on Edit/Write | Blocks hardcoded secrets, SQL injection patterns, command injection |
| Bun test blocker | PreToolUse on Bash | Enforces `bun run test` over `bun test` (the latter uses the Bun test runner instead of Vitest and causes CPU spin) |
| Biome auto-format | PostToolUse on Edit/Write | Auto-formats TypeScript, JavaScript, and JSON files after edits |

## External Dependencies

Some agents reference skills from other plugins:

- `frontend-design` (from `frontend-design` plugin)
- `ui-ux-pro-max` (from `ui-ux-pro-max` plugin)
- `context7-plugin:docs` (from `context7-plugin`)

Install those separately if needed. The core workflow functions without them.

## License

MIT
