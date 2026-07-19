# Docs Scaffold Reference

`scaffoldDocs()` in `dev-init` `lib/docs.ts` — called by `/env-setup` Phase 3 and `/checkup` auto-fix. Additive-only (¬overwrite existing files).

**Write format:** always Markdown (`.md`). Legacy `.mdx` files in older repos are left alone (read-only compatibility). Fumadocs scaffolding was removed.

## CLI

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-docs --path docs
```

`--format` is deprecated and ignored if present.

## Directory Layout

```
{project-root}/
└── docs/
    ├── architecture/
    │   ├── index.md
    │   ├── patterns.md
    │   ├── ubiquitous-language.md
    │   └── adr/                    # ADRs via /adr (always .md)
    ├── standards/
    │   ├── backend-patterns.md
    │   ├── frontend-patterns.md
    │   ├── testing.md
    │   ├── code-review.md
    │   └── configuration.md
    ├── guides/
    │   ├── deployment.md
    │   └── troubleshooting.md
    ├── processes/
    │   ├── dev-process.md
    │   └── issue-management.md
    └── contributing.md
```

Templates live in `plugins/dev-init/skills/init/templates/docs/` (source of truth).

## stack.yml

```yaml
docs:
  framework: none
  path: docs
  format: md
```

`standards.*` paths should point at `.md` files under `docs/`.

## Populate stubs

After scaffold, run `/seed-docs` to replace TODO placeholders from CLAUDE.md + codebase scan.
