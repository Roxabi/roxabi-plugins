# Dev Process Reference

> Contributor view of the `/dev` pipeline (phases, artifacts, git). Not a SSoT for τ.

Let: τ := tier | α := agent

## Tier System

`/dev` chooses τ. Criteria, signals, scoring, label mapping: [tier-classification.md](../skills/shared/references/tier-classification.md).

| τ (from tier-classification.md) | Steps `/dev` runs |
|---|---|
| **S** | triage → implement → pr → validate → review → fix* → promote* → cleanup* |
| **F-lite** | Frame → spec → plan → implement → verify → ship |
| **F-full** | Frame → analyze → spec → plan → implement → verify → ship |

`*` = conditional (runs only if applicable)

## Workflow Phases

Flow: **Frame** (problem) → **Shape** (spec) → **Build** (code) → **Verify** (review) → **Ship** (release).

- **Frame:** Define problem space. Create feature frame from GitHub issue.
- **Shape:** Deep analysis (F-full only), spec, reqs gathering. Specs w/ smart splitting.
- **Build:** Impl plan w/ micro-tasks, code execution, PR creation.
- **Verify:** Code review vs quality gates, fix application, spec validation.
- **Ship:** Post-merge cleanup, promotion to staging/prod.

## Artifact Model

Artifacts = state markers for `/dev` progress detection + resumption.

| Type | Directory | Question |
|------|-----------|----------|
| **Frame** | `artifacts/frames/` | What's the problem? |
| **Brainstorm** | `artifacts/brainstorms/` | What could we do? |
| **Analysis** | `artifacts/analyses/` | How deep? |
| **Spec** | `artifacts/specs/` | What to build? |
| **Plan** | `artifacts/plans/` | How to build? |
| **Visuals** | `artifacts/visuals/` | Architecture diagrams (forge-chart sidecars) |

One kind per directory for **new** writes (β never lands in `analyses/`). `/dev` scans frame/analysis/spec/plan for pipeline progress; brainstorms are exploration seeds (seen by `/interview`, `/analyze`, `/clarify`), not Shape-phase gates. Frontmatter contract: [artifact-frontmatter.md](../skills/shared/references/artifact-frontmatter.md).

## Git Workflow Rules

### Worktree

`/dev` bootstraps the worktree automatically before `frame` (Step 7 silent pre-step via `/setup-worktree`). All tiers (S, F-lite, F-full) execute **code** inside a non-principal worktree on `feat/{N}-{slug}`.

**Invariants** (SSoT: `skills/shared/references/harness-worktree.md`):

- **Principal** (default folder) stays on β (`staging` \| `main`) — never `git switch feat/…` there
- **Branch + issue link** = dev-core (`gh issue develop` → `feat/{N}-{slug}`)
- **Path layout** = harness (Claude: `.claude/worktrees/…` + EnterWorktree; Grok: `~/.grok/worktrees/…` or existing session ω)

```bash
# Identity (always)
gh issue develop N --base "$BASE" --name "feat/N-slug"
# Placement (H_wt-specific — do not hardcode only Claude path)
git worktree add <ω-path> "feat/N-slug"   # principal unchanged
cd <ω-path> && cp .env.example .env && bun install
```

**Exceptions:** `/promote` release artifacts.

¬code on main/staging w/o worktree.

### Commit Format

```
<type>(<scope>): <desc>
```

Types: `feat` | `fix` | `refactor` | `docs` | `style` | `test` | `chore` | `ci` | `perf`

### Branch Naming

`feat/XXX-slug` where XXX = issue number.

## Quality Gate Requirements

- Code review uses Conventional Comments
- Block only on: security, correctness, standard violations
- Must read code-review standards before reviewing
- CI must pass before merge
- Human approves at every gate

## Mandatory Rules

1. **¬force/amend:** ¬`--force`, ¬`--hard`, ¬`--amend`. Hook fail → fix + NEW commit.
2. **Orchestrator delegation:** Orchestrator ¬modify code/docs directly → delegate to domain α. Exception: typo/single-line.
3. **Skill usage:** Always use appropriate skill, even w/o slash command.
4. **Standards reading:** Read relevant standards before code changes.
5. **Test command:** Use `bun run test` (Vitest), ¬`bun test` (Bun runner — CPU spin). Hook blocks wrong cmd.
