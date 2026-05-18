---
name: stack-setup
argument-hint: '[--force]'
description: 'Interactive wizard to fill in .claude/stack.yml through guided questions — asks about runtime, backend, frontend, build, testing, deploy, docs, commands, and standards paths, then writes the file. Triggers: "stack setup" | "setup stack" | "configure stack" | "fill stack.yml" | "stack wizard" | "stack-setup".'
version: 0.3.0
allowed-tools: Read, Edit, Write, Bash, Glob, ToolSearch
---

# Stack Setup Wizard

Auto-discover project config → confirm → write `.claude/stack.yml`. Safe to re-run.

Let: σ := `.claude/stack.yml` | π := proposed config table

## Phase 0 — Idempotency

`test -f .claude/stack.yml && echo exists || echo missing`

σ ∃ ∧ `--force` ∉ `$ARGUMENTS` → → DP(A) **Re-configure** | **Skip**
→ Skip: "Keeping existing σ. Run with `--force` to reconfigure."

σ ∄ → `mkdir -p .claude`

## Phase 1 — Check /init prerequisite

`test -f .claude/dev-core.yml && grep -q 'gh_project_id' .claude/dev-core.yml && echo done || (test -f .env && grep -q 'GH_PROJECT_ID' .env && echo done || echo missing)`

`missing` → → DP(A) **Continue anyway** | **Abort (run /init first)**

## Phase 2 — Auto-discover

Run all detection; derive π:

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

**Runtime/PM → prefix:** `uv` → python/uv/`uv run` | `bun` → bun/bun/`bun run` | `npm/pnpm/yarn` → node/{pm}/`{pm} run`

**Commands by runtime:**
- Python/uv: `dev: uv run <first-script>` | `test: uv run pytest` | `lint: uv run ruff check .` | `format: uv run ruff format .` | `typecheck: uv run ruff check --select=PYI .` | `install: uv sync`
- Node/Bun: `dev/test/lint/format/typecheck: {pm} run <key>` | `install: {pm} install`

**Formatter fix:** ruff → `uv run ruff format . && uv run ruff check --fix .` | biome → `bunx biome check --write` | eslint → `npx eslint --fix .`

**Mixed-stack monorepos** (JS/TS + Python): `formatters:` array instead of `formatter_fix_cmd`:
```yaml
build:
  formatters:
    - cmd: "bunx biome check --write"
      ext: [".ts", ".tsx", ".js", ".jsx", ".json"]
    - cmd: "ruff format"
      ext: [".py"]
```
∀ formatter receives only matching `ext` files. `formatter_fix_cmd` = fallback for single-formatter projects.

**Standards paths** — `docs/` ∃ → include: backend, testing, code_review, architecture, configuration, contributing.

## Phase 3 — Confirm

Display π:

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

→ DP(A) **Looks good — write it** | **Edit a field** | **Abort**

"Edit a field" → ask which + new value; apply; re-display π. Repeat until confirmed.

## Phase 4 — Write stack.yml

Assemble σ. Omit `none`/empty keys entirely.

```yaml
# .claude/stack.yml — dev-core stack configuration
# Commit this file with the project. Secrets live in .env only.
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

# quality_gates: (python only — opt-in code-hygiene guards; omit section entirely when runtime != python)
#   file_length:
#     enabled: true
#     max_lines: 300
#     globs: ["src/**/*.py"]
#     exemptions_file: tools/file_exemptions.txt
#   folder_size:
#     enabled: true
#     max_files: 12
#     globs: ["src/**"]
#     exemptions_file: tools/folder_exemptions.txt
#   import_layers:
#     enabled: true
#     stage: pre-push
#     config: .importlinter

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

**Conditional rendering rules for the template above:**
- `frontend:` — include (uncommented) only if a frontend framework was detected; otherwise omit entirely.
- `shared:` — include only if a monorepo layout was detected; otherwise omit entirely.
- `quality_gates:` — include (uncommented, all three sub-blocks) only if `runtime == python`; otherwise omit the section entirely.

## Phase 4b — Worktree-setup scaffold

Compose `tools/worktree-setup.sh` + `tools/worktree-teardown.sh` from the checklist
and register both hooks in σ. Skipped for unsupported runtimes.

Let:
  WS := tools/worktree-setup.sh
  WT := tools/worktree-teardown.sh
  CL := ${CLAUDE_PLUGIN_ROOT}/references/worktree-setup-checklist.md
  TS := ${CLAUDE_PLUGIN_ROOT}/tools/worktreeScaffold.ts
  CTX := ProjectContext built from Phase 2 detection

1. **Runtime gate.** runtime ∉ {python, bun, node} → D⏭("Worktree-setup scaffold — runtime not supported"), skip phase.

2. **Existence check.** `test -f tools/worktree-setup.sh` →
   - ∃ ∧ ¬`--force` → D("Worktree-setup scaffold", "⏭ Already present"), skip.
   - ∃ ∧ `--force` → DP(A) **Regenerate** | **Keep existing** | **Abort**. "Keep" / "Abort" → skip / abort wizard.

3. **Build ProjectContext** from Phase 2 detection results:
   ```bash
   CTX_JSON=$(cat <<EOF
   {
     "runtime": "${RUNTIME}",
     "package_manager": "${PM}",
     "monorepo": ${MONOREPO_BOOL:-false},
     "hooks_tool": "${HOOKS_TOOL:-lefthook}",
     "env_files": ["${ENV_FILE:-.env}"],
     "database": "${DATABASE:-none}",
     "backend_paths": [${BE_PATH:+\"${BE_PATH}\"}]
   }
   EOF
   )
   ```

4. **Preview.** Run:
   ```bash
   IDS=$(bun "${TS}" list-selected --checklist "${CL}" --context-json "${CTX_JSON}")
   COUNT=$(echo "$IDS" | awk -F, '{print NF}')
   ```
   Echo: `Worktree-setup scaffold preview — {RUNTIME}/{PM} · ${COUNT} concerns: ${IDS}`
   ${COUNT} == 0 → D⏭("Worktree-setup scaffold — no concerns matched"), skip.

5. **Confirm.** → DP(A) **Write scripts** | **Show diff** | **Abort**.
   - **Show diff** → if existing WS ∃, run `diff -u <(bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode setup) tools/worktree-setup.sh | head -80` then re-present DP(A) **Write scripts** | **Abort**.
   - **Abort** → D⏭("Worktree-setup scaffold"), skip.

6. **Write scripts.**
   ```bash
   mkdir -p tools
   bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode setup > tools/worktree-setup.sh
   bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode teardown > tools/worktree-teardown.sh
   chmod +x tools/worktree-setup.sh tools/worktree-teardown.sh
   ```

7. **Register keys in σ.** Append under `commands:` block of `.claude/stack.yml`:
   ```yaml
     worktree_setup: tools/worktree-setup.sh
     worktree_teardown: tools/worktree-teardown.sh
   ```
   Idempotent: skip lines already present.

8. **Report.**
   ```
   Worktree-setup scaffold
     tools/worktree-setup.sh       ✅ Written (${COUNT} concerns: ${IDS})
     tools/worktree-teardown.sh    ✅ Written
     commands.worktree_setup       ✅ Registered in σ
     commands.worktree_teardown    ✅ Registered in σ
   ```

## Phase 5 — CLAUDE.md and reference template

1. **@import:** `head -1 CLAUDE.md` ≠ `@.claude/stack.yml` → prepend; else already present.
2. **Example:** `.claude/stack.yml.example` ∄ → copy σ → "Created as reference template."

Note: `.claude/stack.yml` itself is committed (project stack conventions — no secrets). Only `.env` is gitignored by dev-core. `.claude/dev-core.yml` contains only public GitHub Project node IDs and is committed.

## Phase 6 — Summary

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
  tools/worktree-setup.sh     ✅ Written / Skipped (unsupported runtime | already present)
  tools/worktree-teardown.sh  ✅ Written / Skipped (unsupported runtime | already present)
  commands.worktree_setup     ✅ Registered in σ / Skipped
  commands.worktree_teardown  ✅ Registered in σ / Skipped

  ⚠️  Missing standards docs: (list any configured paths that don't exist on disk)

Next:
  /checkup    Verify all checks pass
  /dev #N     Start working on an issue
```

$ARGUMENTS
