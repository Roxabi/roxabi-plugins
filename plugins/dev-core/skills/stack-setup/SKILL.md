---
name: stack-setup
argument-hint: '[--force]'
description: 'Interactive wizard to fill in .claude/stack.yml through guided questions — asks about runtime, backend, frontend, build, testing, deploy, docs, commands, and standards paths, then writes the file. Triggers: "stack setup" | "setup stack" | "configure stack" | "fill stack.yml" | "stack wizard" | "stack-setup".'
version: 0.1.0
allowed-tools: Read, Edit, Write, Bash, Glob
---

# Stack Setup Wizard

Walk the user through every section of `.claude/stack.yml` with guided questions. Write the file at the end. Safe to re-run.

## Phase 1 — Idempotency check

Check: `test -f .claude/stack.yml && echo exists || echo missing`

If exists and `$ARGUMENTS` does not contain `--force`:
AskUserQuestion: **Re-configure** (overwrite existing stack.yml) | **Skip** (abort — keep current file)
→ Skip: abort with "Keeping existing `.claude/stack.yml`. Run with `--force` to reconfigure."

If missing, create `.claude/` directory: `mkdir -p .claude`

## Phase 2 — Runtime & package manager

AskUserQuestion:
- **Package manager?** — **bun** | **npm** | **pnpm** | **yarn**

Derive `runtime`:
- bun → `bun`
- npm / pnpm / yarn → `node`

Store: `PM`, `RUNTIME`

## Phase 3 — Backend

AskUserQuestion: **Does this project have a backend?** — **Yes** | **No**

If Yes:
1. AskUserQuestion: **Backend framework?** — **NestJS** | **Express** | **Fastify** | **Django** | **Rails** | **Other**
   - Other → AskUserQuestion (free text): "Enter the framework name:"
   - Store as lowercase: `nestjs`, `express`, `fastify`, `django`, `rails`, or user input
2. AskUserQuestion: **ORM / database layer?** — **Drizzle** | **Prisma** | **TypeORM** | **Mongoose** | **None**
   - Store as lowercase: `drizzle`, `prisma`, `typeorm`, `mongoose`, `none`
3. AskUserQuestion: **Backend app path?** (relative to project root)
   - Default suggestion: `apps/api` (monorepo) or `src` (single-app) — present as options
   - **apps/api** | **src** | **backend** | **Other**
   - Other → free text input

If No: set backend fields to `none`/empty.

## Phase 4 — Frontend

AskUserQuestion: **Does this project have a frontend?** — **Yes** | **No**

If Yes:
1. AskUserQuestion: **Frontend framework?** — **TanStack Start** | **Next.js** | **Remix** | **SvelteKit** | **Nuxt** | **Other**
   - Store: `tanstack-start`, `nextjs`, `remix`, `sveltekit`, `nuxt`, or user input
2. AskUserQuestion: **Frontend app path?**
   - **apps/web** | **app** | **src** | **frontend** | **Other**
3. AskUserQuestion: **Shared UI package import path?** (what you import from in code)
   - **@repo/ui** | **@/components/ui** | **$lib/components** | **None / not applicable** | **Other**
   - None → skip `ui_src` question
   - Other → free text
4. If UI package was set: AskUserQuestion: **UI source directory?** (where components are defined)
   - Default: derive from UI package path — e.g., `@repo/ui` → suggest `packages/ui/src`
   - **packages/ui/src** | **src/components/ui** | **src/lib/components** | **Other**

If No: set frontend fields to `none`/empty.

## Phase 5 — Shared packages (monorepo only)

AskUserQuestion: **Is this a monorepo with shared packages?** — **Yes** | **No**

If Yes:
1. AskUserQuestion: **Shared types package path?** — **packages/types** | **packages/shared** | **shared/types** | **Other / None**
2. AskUserQuestion: **Shared UI package directory?** — **packages/ui** | **packages/components** | **Other / None**
3. AskUserQuestion: **Shared config package path?** — **packages/config** | **config** | **Other / None**
   - "None" → leave field empty

If No: leave shared fields empty.

## Phase 6 — Build tooling

1. AskUserQuestion: **Build orchestrator?** — **Turbo** | **Nx** | **None**
   - Turbo → `orchestrator_config: turbo.jsonc`
   - Nx → `orchestrator_config: nx.json`
   - None → skip config field

2. AskUserQuestion: **Code formatter / linter?** — **Biome** | **ESLint** | **ESLint + Prettier** | **None**
   - Biome → `formatter_config: biome.json`, `formatter_fix_cmd: "bunx biome check --write"`
   - ESLint → `formatter_config: .eslintrc.*`, `formatter_fix_cmd: "npx eslint --fix"`
   - ESLint + Prettier → `formatter_config: .eslintrc.*`, `formatter_fix_cmd: "npx prettier --write . && npx eslint --fix"`
   - None → skip

## Phase 7 — Testing

1. AskUserQuestion: **Unit / integration test framework?** — **Vitest** | **Jest** | **Pytest** | **None**
2. AskUserQuestion: **E2E test framework?** — **Playwright** | **Cypress** | **None**

## Phase 8 — Deployment

AskUserQuestion: **Deployment platform?** — **Vercel** | **Railway** | **Fly.io** | **AWS** | **None**

Derive `secrets_cmd`:
- Vercel → `vercel env add`
- Railway → `railway variables set`
- Fly.io → `fly secrets set`
- AWS → `aws ssm put-parameter`
- None → leave empty

## Phase 9 — Documentation

AskUserQuestion: **Does this project have a documentation site?** — **Yes** | **No**

If Yes:
1. AskUserQuestion: **Docs framework?** — **Fumadocs** | **Docusaurus** | **Nextra** | **None / plain Markdown**
2. AskUserQuestion: **Docs directory?** — **docs** | **documentation** | **website** | **Other**
3. AskUserQuestion: **Docs file format?** — **MDX** | **Markdown**

If No: set `docs.framework: none`, `docs.path: docs`, `docs.format: md`

## Phase 10 — Commands

Derive defaults from `PM` (package manager) — no need to ask unless user wants to override.

Default derivation:
```
dev:        {PM} run dev
build:      {PM} run build
test:       {PM} run test
lint:       {PM} run lint
typecheck:  {PM} run typecheck
format:     (from formatter_fix_cmd above)
install:    {PM} install
```

AskUserQuestion: **Customize commands?** — **Use defaults** | **Customize**

If Customize → for each command, AskUserQuestion (free text) with the default pre-shown.

## Phase 11 — Artifact directories

Use defaults. No questions unless `--force`.
```
analyses: artifacts/analyses
specs:    artifacts/specs
frames:   artifacts/frames
plans:    artifacts/plans
```

AskUserQuestion: **Artifact directories?** — **Use defaults** | **Customize**

If Customize → ask for each path (free text).

## Phase 12 — Standards doc paths

Auto-suggest paths based on `docs.path` chosen in Phase 9. Present each as a question with a sensible default.

For each standards key, AskUserQuestion with inferred default:
- **backend** → `{docs.path}/standards/backend-patterns.{docs.format}`
- **frontend** → `{docs.path}/standards/frontend-patterns.{docs.format}`
- **testing** → `{docs.path}/standards/testing.{docs.format}`
- **code_review** → `{docs.path}/standards/code-review.{docs.format}`
- **architecture** → `{docs.path}/architecture/`
- **configuration** → `{docs.path}/configuration.{docs.format}`
- **deployment** → `{docs.path}/guides/deployment.{docs.format}`
- **troubleshooting** → `{docs.path}/guides/troubleshooting.{docs.format}`
- **issue_management** → `{docs.path}/processes/issue-management.{docs.format}`
- **dev_process** → `{docs.path}/processes/dev-process.{docs.format}`
- **contributing** → `{docs.path}/contributing.{docs.format}`

Batch questions where possible — AskUserQuestion: **Use all defaults** | **Customize individual paths**

If "Customize": step through each key individually with its default pre-shown.

Check which standards paths actually exist on disk. For each missing path, warn inline:
`⚠️ standards.{key}: {path} does not exist yet. Create the doc before running that agent, or update the path.`

## Phase 13 — Write stack.yml

Assemble and write `.claude/stack.yml` using all collected values.

Do NOT write keys that were set to "None" / "not applicable" — omit them entirely.

Template:
```yaml
# .claude/stack.yml — dev-core stack configuration
# DO NOT commit this file. Add .claude/stack.yml to .gitignore.
# Commit .claude/stack.yml.example instead.
schema_version: "1.0"

runtime: {RUNTIME}
package_manager: {PM}

backend:
  framework: {BE_FRAMEWORK}
  orm: {BE_ORM}
  path: {BE_PATH}

frontend:
  framework: {FE_FRAMEWORK}
  path: {FE_PATH}
  ui_package: {FE_UI_PACKAGE}
  ui_src: {FE_UI_SRC}

# ... (only include sections that were answered)
```

## Phase 14 — CLAUDE.md and .gitignore

1. **Add @import:** Check `head -1 CLAUDE.md`. If first line ≠ `@.claude/stack.yml`:
   - Prepend `@.claude/stack.yml` as a new first line.
   - Display: "Added `@.claude/stack.yml` import to CLAUDE.md ✅"
   - Else: "CLAUDE.md already imports stack.yml ✅"

2. **Add to .gitignore:** Check `grep -q '\.claude/stack\.yml' .gitignore 2>/dev/null`
   - If missing: append `.claude/stack.yml` to `.gitignore`
   - Display: "Added `.claude/stack.yml` to .gitignore ✅"
   - Else: "Already in .gitignore ✅"

3. **Copy example file:** If `.claude/stack.yml.example` does not exist:
   - Copy `.claude/stack.yml` to `.claude/stack.yml.example`
   - Display: "Created `.claude/stack.yml.example` ✅ — commit this file as a reference for teammates"

## Phase 15 — Summary

Display a table of all written values and the status of each action:

```
Stack configuration written
===========================

  Runtime:          {RUNTIME} / {PM}
  Backend:          {BE_FRAMEWORK} + {BE_ORM} at {BE_PATH}
  Frontend:         {FE_FRAMEWORK} at {FE_PATH}
  UI package:       {FE_UI_PACKAGE} (src: {FE_UI_SRC})
  Shared:           types={} ui={} config={}
  Build:            {ORCHESTRATOR} + {FORMATTER}
  Testing:          {UNIT} + {E2E}
  Deploy:           {PLATFORM}
  Docs:             {DOCS_FRAMEWORK} at {DOCS_PATH}

  .claude/stack.yml           ✅ Written
  CLAUDE.md @import           ✅ Added / Already present
  .gitignore                  ✅ Updated / Already set
  .claude/stack.yml.example   ✅ Created / Already exists

  ⚠️  Missing standards docs: (list any that don't exist on disk)

Next:
  /doctor     Verify all checks pass
  /dev #N     Start working on an issue
```

$ARGUMENTS
