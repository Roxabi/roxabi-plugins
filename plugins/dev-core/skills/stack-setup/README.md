# stack-setup

Interactive wizard to fill in `.claude/stack.yml` through guided auto-detection and confirmation.

## Why

`stack.yml` is the configuration file that all dev-core skills read to find commands, file paths, and framework settings. `/stack-setup` auto-detects your runtime, package manager, framework, ORM, test runner, linter, and docs path from project files — then lets you confirm or edit before writing.

## Usage

```
/stack-setup           Auto-detect and write stack.yml (skips if already exists)
/stack-setup --force   Re-run, overwriting existing config
```

Triggers: `"stack setup"` | `"setup stack"` | `"configure stack"` | `"fill stack.yml"` | `"stack wizard"`

## How it works

1. **Idempotency check** — if `stack.yml` exists and `--force` is absent, asks to re-configure or skip.
2. **Auto-discover** — runs detection scripts for:
   - Runtime + package manager (pyproject.toml, bun.lockb, pnpm-lock.yaml, yarn.lock, package.json)
   - Backend path (pyproject.toml packages, src/, apps/api/)
   - Backend framework (Typer, FastAPI, Flask, Django, NestJS, Express, Fastify)
   - Frontend framework (Next.js, SvelteKit, Remix, Nuxt, TanStack Start)
   - ORM (Drizzle, Prisma, Mongoose, TypeORM)
   - Test framework (pytest, Vitest, Jest)
   - Linter/formatter (Ruff, Biome, ESLint)
   - Build orchestrator (Turbo, Nx)
   - Docs path
3. **Confirm** — displays detected configuration table; lets you edit any field before writing.
4. **Write** — creates `.claude/stack.yml` (committed with project), prepends `@.claude/stack.yml` to CLAUDE.md, creates `.claude/stack.yml.example` (reference template).

## Mixed-stack monorepos

For projects with both JS/TS and Python, generates a `formatters:` array instead of a single `formatter_fix_cmd`:

```yaml
build:
  formatters:
    - cmd: "bunx biome check --write"
      ext: [".ts", ".tsx", ".js"]
    - cmd: "ruff format"
      ext: [".py"]
```
