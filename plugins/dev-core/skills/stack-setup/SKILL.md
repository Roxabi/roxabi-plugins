---
name: stack-setup
argument-hint: '[--force]'
description: 'Interactive wizard to fill in .claude/stack.yml through guided questions — asks about runtime, backend, frontend, build, testing, deploy, docs, commands, and standards paths, then writes the file. Triggers: "stack setup" | "setup stack" | "configure stack" | "fill stack.yml" | "stack wizard" | "stack-setup".'
version: 0.2.0
allowed-tools: Read, Edit, Write, Bash, Glob
---

# Stack Setup Wizard

Auto-discovers your project configuration from the codebase, shows a confirmation screen, then writes `.claude/stack.yml`. Safe to re-run.

## Phase 0 — Idempotency check

Check: `test -f .claude/stack.yml && echo exists || echo missing`

If exists and `$ARGUMENTS` does not contain `--force`:
AskUserQuestion: **Re-configure** (overwrite existing stack.yml) | **Skip** (abort — keep current file)
→ Skip: abort with "Keeping existing `.claude/stack.yml`. Run with `--force` to reconfigure."

If missing, create `.claude/` directory: `mkdir -p .claude`

## Phase 1 — Check /init prerequisite

Run: `test -f .env && grep -q 'GH_PROJECT_ID' .env && echo done || echo missing`

If `missing`:
Display warning:
> ⚠️ `/init` has not been run yet — GitHub project integration won't work until you do.

AskUserQuestion: **Continue anyway** | **Abort (run /init first)**
→ Abort: stop with "Run `/init` to set up GitHub integration, then come back to `/stack-setup`."

## Phase 2 — Auto-discover project configuration

Run all detection commands. Collect results and derive the proposed config.

```bash
# Runtime & package manager
echo "--- RUNTIME ---"
if [ -f pyproject.toml ]; then
  grep -q '\[tool\.uv\]' pyproject.toml && echo "runtime=python pm=uv" || echo "runtime=python pm=pip"
elif [ -f bun.lockb ]; then echo "runtime=bun pm=bun"
elif [ -f pnpm-lock.yaml ]; then echo "runtime=node pm=pnpm"
elif [ -f yarn.lock ]; then echo "runtime=node pm=yarn"
elif [ -f package.json ]; then echo "runtime=node pm=npm"
else echo "runtime=unknown pm=unknown"
fi

# Source / backend path
echo "--- SOURCE PATH ---"
grep -oP '(?<=packages = \[")[^"]+' pyproject.toml 2>/dev/null | head -1 \
  || (test -d src && echo "src") \
  || (test -d apps/api && echo "apps/api") \
  || echo ""

# Backend framework
echo "--- BACKEND FRAMEWORK ---"
grep -iE '\btyper\b|\bfastapi\b|\bflask\b|\bdjango\b' pyproject.toml 2>/dev/null | head -1 \
  || grep -oE '"@nestjs/core"|"express"|"fastify"' package.json 2>/dev/null | head -1 \
  || echo "none"

# Frontend framework
echo "--- FRONTEND FRAMEWORK ---"
grep -oE '"next"|"@sveltejs/kit"|"@remix-run/react"|"nuxt"|"@tanstack/start"' package.json 2>/dev/null | head -1 \
  || echo "none"

# ORM
echo "--- ORM ---"
grep -oE '"drizzle-orm"|"@prisma/client"|"@prisma/client"|"mongoose"|"typeorm"' package.json 2>/dev/null | head -1 \
  || echo "none"

# Test framework
echo "--- TESTING ---"
grep -q 'pytest' pyproject.toml 2>/dev/null && echo "pytest" \
  || grep -oE '"vitest"|"jest"' package.json 2>/dev/null | head -1 \
  || echo "none"

# Linter / formatter
echo "--- LINTER ---"
grep -q '\[tool\.ruff\]' pyproject.toml 2>/dev/null && echo "ruff config=pyproject.toml" \
  || (test -f biome.json && echo "biome config=biome.json") \
  || grep -q '"eslint"' package.json 2>/dev/null && echo "eslint config=.eslintrc.*" \
  || echo "none"

# Build orchestrator
echo "--- ORCHESTRATOR ---"
(test -f turbo.jsonc && echo "turbo config=turbo.jsonc") \
  || (test -f turbo.json && echo "turbo config=turbo.json") \
  || (test -f nx.json && echo "nx config=nx.json") \
  || echo "none"

# Docs
echo "--- DOCS ---"
test -d docs && echo "path=docs format=md" || echo "none"

# Project scripts (entry points)
echo "--- PROJECT SCRIPTS ---"
grep -A5 '^\[project\.scripts\]' pyproject.toml 2>/dev/null | grep -v '^\[' | head -5 \
  || (grep '"scripts"' package.json 2>/dev/null && python3 -c "import json,sys; pkg=json.load(open('package.json')); [print(f'{k}={v}') for k,v in (pkg.get('scripts') or {}).items() if k in ['dev','build','test','lint','typecheck','format']]" 2>/dev/null) \
  || echo ""
```

From the output, derive the proposed config:

**Runtime/PM mapping:**
- `pm=uv` → `runtime: python`, `package_manager: uv`; commands prefixed with `uv run`
- `pm=bun` → `runtime: bun`, `package_manager: bun`; commands prefixed with `bun run`
- `pm=npm/pnpm/yarn` → `runtime: node`, `package_manager: {pm}`; commands prefixed with `{pm} run`

**Commands derivation by runtime:**
- Python/uv: `dev: uv run <first-script-key>`, `test: uv run pytest`, `lint: uv run ruff check .`, `format: uv run ruff format .`, `typecheck: uv run ruff check --select=PYI .`, `install: uv sync`
- Node/Bun: `dev: {pm} run dev`, `test: {pm} run test`, `lint: {pm} run lint`, `format: {pm} run format`, `typecheck: {pm} run typecheck`, `install: {pm} install`

**Formatter fix command:**
- ruff → `uv run ruff format . && uv run ruff check --fix .`
- biome → `bunx biome check --write` (or `npx biome check --write`)
- eslint → `npx eslint --fix .`

**Mixed-stack monorepos (FE+BE with different formatters):**
When both JS/TS and Python sources are detected (e.g. `fe/` + `be/` dirs), write `formatters:` array instead of `formatter_fix_cmd`:
```yaml
build:
  formatters:
    - cmd: "bunx biome check --write"
      ext: [".ts", ".tsx", ".js", ".jsx", ".json"]
    - cmd: "ruff format"
      ext: [".py"]
```
Each formatter only receives files matching its `ext` list. `formatter_fix_cmd` is the fallback for single-formatter projects.

**Standards paths** (only include if `docs/` exists on disk):
- backend, testing, code_review, architecture, configuration, contributing

## Phase 3 — Confirm detected configuration

Display the full proposed config as a preview table:

```
Detected configuration
======================

  Runtime:     {runtime} / {pm}
  Backend:     {framework} at {path}
  Frontend:    {frontend_framework | "none"}
  ORM:         {orm | "none"}
  Testing:     {test_framework | "none"}
  Linter:      {formatter} ({formatter_config})
  Orchestrator:{orchestrator | "none"}
  Docs:        {docs_path | "none"}

  Commands:
    dev:        {dev_cmd}
    test:       {test_cmd}
    lint:       {lint_cmd}
    format:     {format_cmd}
    typecheck:  {typecheck_cmd}
    install:    {install_cmd}
```

AskUserQuestion: **Looks good — write it** | **Edit a field** | **Abort**

If "Edit a field": ask "Which field? (e.g. `runtime`, `backend.path`, `commands.test`)" and "New value?". Apply the override and re-display the table. Repeat until confirmed.

## Phase 4 — Write stack.yml

Assemble and write `.claude/stack.yml` using the confirmed values.

Do NOT write keys that are `none` / empty — omit them entirely.

```yaml
# .claude/stack.yml — dev-core stack configuration
# DO NOT commit this file. Add .claude/stack.yml to .gitignore.
# Commit .claude/stack.yml.example instead.
schema_version: "1.0"

runtime: {RUNTIME}
package_manager: {PM}

backend:
  framework: {BE_FRAMEWORK}
  path: {BE_PATH}
  # orm: {BE_ORM}  (only if orm != none)

# frontend: (only if frontend framework detected)
#   framework: {FE_FRAMEWORK}
#   path: {FE_PATH}

# shared: (only if monorepo detected)
#   types: packages/types
#   ui: packages/ui
#   config: packages/config

build:
  # orchestrator: {ORCHESTRATOR}  (only if detected)
  # orchestrator_config: {ORCHESTRATOR_CONFIG}
  formatter: {FORMATTER}
  formatter_config: {FORMATTER_CONFIG}
  formatter_fix_cmd: "{FORMATTER_FIX_CMD}"  # single formatter; use formatters[] for mixed stacks
  # formatters:                              # mixed-stack alternative (FE JS + BE Python etc.)
  #   - cmd: "bunx biome check --write"
  #     ext: [".ts", ".tsx", ".js", ".jsx", ".json"]
  #   - cmd: "ruff format"
  #     ext: [".py"]

testing:
  unit: {UNIT_TEST}
  # e2e: (only if playwright/cypress detected)

deploy:
  platform: none

docs:
  framework: none
  path: {DOCS_PATH}
  format: md

commands:
  dev: {DEV_CMD}
  test: {TEST_CMD}
  lint: {LINT_CMD}
  format: {FORMAT_CMD}
  typecheck: {TYPECHECK_CMD}
  install: {INSTALL_CMD}

artifacts:
  analyses: artifacts/analyses
  specs: artifacts/specs
  frames: artifacts/frames
  plans: artifacts/plans

# standards: (only if docs/ exists on disk)
#   backend: {docs}/standards/backend-patterns.md
#   testing: {docs}/standards/testing.md
#   code_review: {docs}/standards/code-review.md
#   architecture: {docs}/architecture/
#   configuration: {docs}/configuration.md
#   contributing: {docs}/contributing.md
```

## Phase 5 — CLAUDE.md and .gitignore

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

## Phase 6 — Summary

Display a table of all written values and the status of each action:

```
Stack configuration written
===========================

  Runtime:     {RUNTIME} / {PM}
  Backend:     {BE_FRAMEWORK} at {BE_PATH}
  Frontend:    {FE_FRAMEWORK | "none"}
  Testing:     {UNIT_TEST}
  Linter:      {FORMATTER} ({FORMATTER_CONFIG})
  Docs:        {DOCS_PATH | "none"}

  .claude/stack.yml           ✅ Written
  CLAUDE.md @import           ✅ Added / Already present
  .gitignore                  ✅ Updated / Already set
  .claude/stack.yml.example   ✅ Created / Already exists

  ⚠️  Missing standards docs: (list any configured paths that don't exist on disk)

Next:
  /doctor     Verify all checks pass
  /dev #N     Start working on an issue
```

$ARGUMENTS
