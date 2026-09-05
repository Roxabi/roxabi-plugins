# Docs Scaffold Reference

`scaffoldDocs()` in `skills/dev-init/lib/docs.ts` — called by `/R-env-setup` Phase 3 and `/R-dev-checkup` auto-fix. Additive-only (¬overwrite existing files).

**Write format:** always Markdown (`.md`). Legacy `.mdx` files in older repos are left alone (read-only compatibility). Fumadocs scaffolding was removed.

## CLI

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/dev-init/init.ts" scaffold-docs --path docs
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
    │   └── adr/                    # ADRs via /R-adr (always .md)
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

Templates live in `plugins/dev-core/skills/dev-init/templates/docs/` (source of truth).

## stack.yml

```yaml
docs:
  framework: none
  path: docs
  format: md
```

`standards.*` paths should point at `.md` files under `docs/`.

## Populate stubs

After scaffold, run `/R-seed-docs` to replace TODO placeholders from CLAUDE.md + codebase scan.
