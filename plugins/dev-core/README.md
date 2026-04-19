# dev-core

Full development lifecycle orchestrator for Roxabi projects. Covers framing, analysis, specification, planning, implementation, review, and shipping. Opinionated workflow with 29 skills, 9 specialized agents, and safety hooks.

## Prerequisites

- **Package manager** — Bun, npm, pnpm, or yarn (configured via `stack.yml`)
- [GitHub CLI](https://cli.github.com/) (`gh`) — issue fetching, PR creation, label management
- **Formatter** — optional; configure any formatter in `stack.yml` (`build.formatter_fix_cmd` or `build.formatters[]`). Biome, Prettier, Ruff, Black — all work. Leave empty to disable auto-formatting.

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

After installing, run init to configure your project:

```
/init
```

Auto-detects your GitHub repo, Project V2 board, and field IDs. Writes `.claude/dev-core.yml` (primary config) and `.env` (legacy fallback), registers the project in `~/.roxabi-vault/workspace.json` for the multi-project dashboard, generates a self-healing `roxabi` shim, and creates the `artifacts/` directory. Works for any project type. Re-run with `/init --force` to reconfigure.

Then configure the agent stack:

```
/stack-setup
```

Auto-discovers your runtime, framework, test tooling, and linter from the codebase, shows a confirmation screen, and writes `.claude/stack.yml` so all agents know where things live.

**Project-agnostic:** All skills and agents read commands and paths from `.claude/stack.yml` at runtime — `{commands.test}`, `{commands.lint}`, `{package_manager}`, `{backend.path}`, etc. If a required field is missing, the agent immediately tells you to run `/init` or `/stack-setup`. This means dev-core works with any stack — Bun/npm/pnpm/yarn, NestJS/Express/Django, Vitest/Jest/Pytest.

**Important:** `/init` is required for project board features (issue status, size, priority fields). Without it, issue creation and dependency management still work, but field updates will show a "not configured" error pointing back to `/init`.

## Usage

The main entry point is:

```
/dev #N
```

Where `#N` is a GitHub issue number. The orchestrator scans existing artifacts, determines the issue tier (S / F-lite / F-full), shows current progress, and delegates to the right phase skill. It drives the full lifecycle from issue to merged PR.

## Skills

30 skills organized by workflow phase:

| Skill | Phase | Description |
|-------|-------|-------------|
| `init` | Setup | Configures project for dev-core (GitHub Project V2, labels, CI/CD workflows, branch protection, env vars, workspace.json registration, VS Code MDX preview, LSP plugin install). Pushes workflow files directly via GitHub REST API — no local git required. Auto-sets PAT secret after workflow creation. Lists built-in project workflow status; GitHub has no API to enable them programmatically — provides direct settings URL. TypeScript CLI with subcommands, SKILL.md orchestrates via DP(n) decisions |
| `env-setup` | Setup | Set up local dev environment — stack.yml, CLAUDE.md Critical Rules, docs scaffolding, VS Code MDX, LSP. Triggered by `/init` or standalone |
| `github-setup` | Setup | Connect project to GitHub Project V2 board — discover or create board, labels, branch protection, workspace registration |
| `ci-setup` | Setup | Set up CI/CD — GitHub Actions workflows, TruffleHog, Dependabot, pre-commit hooks, marketplace plugins. Discovers Roxabi plugins live from `marketplace.json` and endorsed external marketplaces from `curated-marketplaces.json` |
| `stack-setup` | Setup | Auto-discovers runtime, framework, test tooling, and linter from the codebase, then writes `.claude/stack.yml`. Single confirmation screen — no wizard questions |
| `doctor` | Setup | Project-type-aware health check — verifies prerequisites, GitHub config, labels, CI/CD workflows (checks both local files and remote via REST API), required secrets (PAT for auto-merge.yml), branch protection, stack.yml, workspace.json registration, VS Code MDX preview, and LSP plugin install (typescript-lsp / pyright-lsp with auto-fix). Distinguishes ❌ blocking errors from ⚠️ optional warnings; exits 0 when warnings-only |
| `seed-docs` | Setup | Populates scaffolded architecture/standards docs with real content — reads CLAUDE.md for conventions, optionally scans codebase (entry points, import graph, naming patterns), fills TODO stubs, writes AI Quick Reference sections. Idempotent: skips already-populated files |
| `seed-community` | Setup | Bootstraps OSS community health files — CONTRIBUTING.md, LICENSE, SECURITY.md, CODE_OF_CONDUCT.md, README sections (Getting Started, Badges), `.github/PULL_REQUEST_TEMPLATE.md`, issue templates. Reads project metadata + CLAUDE.md; generates missing files idempotently |
| `dev` | Orchestrator | Routes issues through the full workflow |
| `frame` | Frame | Creates initial feature frame from issue |
| `analyze` | Shape | Deep analysis with expert consultation |
| `spec` | Shape | Generates specifications with smart splitting |
| `interview` | Shape | Interactive requirements gathering |
| `plan` | Build | Creates implementation plan with micro-tasks |
| `implement` | Build | Executes implementation from plan — merge conflict recovery, abandon-on-3-failures option |
| `pr` | Build | Creates pull request with proper format |
| `review` | Verify | Code review against quality gates — secret scan before spawning agents |
| `fix` | Verify | Applies fixes from review feedback |
| `validate` | Verify | Validates implementation against spec |
| `cleanup` | Ship | Post-merge cleanup |
| `promote` | Ship | Promotes to staging/production |
| `test` | Supporting | Runs and manages tests |
| `issues` | Supporting | Lists/dashboards GitHub issues — status, deps, backlog; `--tree`/`-T` for compact hierarchy view |
| `issue-triage` | Supporting | Triages GitHub issues with labels/priority |
| `adr` | Supporting | Creates Architecture Decision Records |
| `doc-sync` | Supporting | Syncs CLAUDE.md, README.md, and plugin SKILL.md after a code change |
| `readme-upgrade` | Supporting | Audits and improves root README, CONTRIBUTING.md, and plugin READMEs against the developer-tool quality pattern (Why, Quick Start, How it works, categorized tables, diagrams). Auto-detects Mermaid vs ASCII based on host |
| `cleanup-context` | Supporting | Audits and cleans CLAUDE.md, memory, skills, and rules — resolves every finding (fix/promote/relocate/delete), tracks recurrences, targets bloat=0 |
| `ci-watch` | Supporting | Watch a CI run with live emoji dashboard — polls every Ns, shows job/step status, dumps failed logs on error. Auto-detects `ci.yml` workflow |
| `release-setup` | Supporting | Wires release-please for a repo — tag convention, manifest, config, workflow. Re-run with `--force` to patch. **Quality gates** (Python only) — optional `quality_gates:` section in `stack.yml` installs file-length / folder-size / import-layer pre-commit hooks. See [`skills/release-setup/cookbooks/quality-gates.md`](skills/release-setup/cookbooks/quality-gates.md) |

## Agents

9 specialized agents organized in three tiers. Each agent has a built-in **config guard** (fails fast if `stack.yml` is missing), a domain-specific **escalation path** (knows who to message for out-of-scope issues), and a **confidence threshold** (stops and escalates instead of guessing when certainty is below 70–80%).

Each agent frontmatter includes a `# capabilities:` comment (`write_knowledge`, `write_code`, `review_code`, `run_tests`) for human-readable permission reference, and a `# based-on:` traceability comment. All agents inline a base communication + research-order protocol in their body. `backend-dev`, `frontend-dev`, `fixer`, and `tester` additionally inline quality-gate rules. The shared reference files live in `skills/shared/references/` (`base.md`, `engineer.md`).

### Domain

| Agent | Role |
|-------|------|
| `frontend-dev` | Frontend implementation (`{frontend.path}`, `{shared.ui}` from stack.yml) |
| `backend-dev` | Backend implementation (`{backend.path}`, `{shared.types}` from stack.yml) |
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

## Project-Level Overrides

`stack.yml` handles most project adaptation (paths, commands, standards docs). For behavioral changes — project-specific constraints, tighter escalation rules, extra checklist phases — override any agent or skill at the project level.

Claude Code resolves `.claude/agents/<name>.md` over the plugin cache automatically. Drop a file there and it replaces the plugin agent for that project only. Skills work the same way via `.claude/skills/<name>/SKILL.md`.

See [`references/project-overrides.md`](references/project-overrides.md) for full anatomy, examples, and what to keep vs change.

## Hooks

Three Claude Code hooks for safety and consistency:

| Hook | Trigger | What it does |
|------|---------|--------------|
| Security check | PreToolUse on Edit/Write | Blocks hardcoded secrets, SQL injection patterns, command injection |
| Bun test blocker | PreToolUse on Bash | Enforces `bun run test` over `bun test` (the latter uses the Bun test runner instead of Vitest and causes CPU spin) |
| Auto-format | PostToolUse on Edit/Write | Reads `build.formatter_fix_cmd` (single) or `build.formatters[]` (multi, for mixed JS+Python monorepos) from `stack.yml` and runs the right formatter per file extension. Silent no-op when unconfigured. |

## External Dependencies

Some agents reference skills from other plugins:

- `frontend-design` (from `frontend-design` plugin)
- `ui-ux-pro-max` (from `ui-ux-pro-max` plugin)
- `context7-plugin:docs` (from `context7-plugin`)

Install those separately if needed. The core workflow functions without them.

## License

MIT
