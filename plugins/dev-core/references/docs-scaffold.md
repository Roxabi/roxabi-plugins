# Fumadocs Scaffold Reference

When `docs.framework: fumadocs` in `.claude/stack.yml`, `/init` Phase 7 generates a full Fumadocs site. Split across `apps/docs/` (Next.js app) + `docs/` (MDX content).

`scaffoldFumadocs()` in `lib/fumadocs.ts` — called by `/init` Phase 7. Additive-only (¬overwrite existing files).

Produces working site: Mermaid diagrams, Shiki highlighting, dark/light theme, `meta.json` nav.

## Directory Layout

```
{project-root}/
├── apps/
│   └── docs/
│       ├── app/
│       │   ├── layout.tsx                    # RootProvider + back-link to NEXT_PUBLIC_APP_URL (default: roxabi.com)
│       │   ├── page.tsx                      # redirects to /docs
│       │   └── docs/
│       │       ├── layout.tsx                # DocsLayout
│       │       └── [[...slug]]/
│       │           └── page.tsx              # dynamic doc page (toc, metadata, Mermaid)
│       ├── src/
│       │   ├── lib/
│       │   │   ├── source.ts                 # fumadocs-core loader
│       │   │   └── shiki.ts                  # Shiki config (experimentalJSEngine, dual themes)
│       │   └── components/
│       │       └── mdx/
│       │           └── Mermaid.tsx           # client component, theme-aware, DOMPurify-sanitized
│       ├── globals.css                       # Tailwind + fumadocs-ui preset + neutral theme
│       ├── mdx-components.tsx                # useMDXComponents with Mermaid
│       ├── postcss.config.mjs                # Tailwind v4 PostCSS
│       ├── source.config.ts                  # fumadocs-mdx config + remarkMdxMermaid + shiki
│       ├── next.config.ts                    # Next.js + createMDX + output: standalone
│       ├── tsconfig.json                     # @/* → ./src/*, @/.source → .source/index.ts
│       └── package.json                      # all deps (see below)
└── docs/
    ├── index.mdx                             # home doc placeholder
    └── meta.json                             # root navigation
```

## Required Packages (apps/docs/)

| Package | Version | Notes |
|---------|---------|-------|
| fumadocs-ui | ^15.4.2 | UI components + layouts |
| fumadocs-core | ^15.4.2 | Core loader + plugins |
| fumadocs-mdx | ^11.6.7 | MDX processing |
| next | ^15.3.4 | Next.js app |
| react / react-dom | ^19.2.4 | React |
| mermaid | ^11.4.1 | Diagram rendering |
| dompurify | ^3.3.2 | SVG sanitization |
| next-themes | ^0.4.6 | Theme switching |
| shiki | ^3.4.0 | Syntax highlighting |
| tailwindcss | ^4.1.0 | Styling |
| @tailwindcss/postcss (dev) | ^4.1.0 | Tailwind v4 PostCSS plugin |
| @types/dompurify (dev) | ^3.2.0 | DOMPurify types |
| @types/mdx (dev) | ^2.0.13 | MDX types |

## Key Design Decisions

- **`@/*`** → `./src/*` via tsconfig paths — clean imports under `src/`
- **`@/.source`** → `.source/index.ts` — codegen output from `fumadocs-mdx` at build time (only non-`src/` alias)
- **Mermaid** — client-side via `Mermaid.tsx`. `remarkMdxMermaid` extracts code blocks at build; component calls `mermaid.render()` + DOMPurify sanitize. `next-themes` picks correct theme (`neutral` vs `dark`)
- **Shiki** — `experimentalJSEngine` avoids OOM on CI. Dual themes (light/dark)
- **Back-link** — `app/layout.tsx` reads `NEXT_PUBLIC_APP_URL ?? 'https://roxabi.com'`
- **`output: standalone`** — self-contained build for Docker/Railway

## Additive-Only Rule

∃ file at scaffold path → skip + stdout warning. ¬overwrite. Safe to re-run after partial scaffold ∨ manual edits.

## Running

Set in `.claude/stack.yml`:

```yaml
docs:
  framework: fumadocs
  path: docs
  format: mdx
```

Then `/init` — Phase 7 detects `docs.framework: fumadocs`, offers scaffold.

Direct trigger (w/o full `/init`):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs --root <project-root>
```

After scaffold:

```bash
cd apps/docs && bun install
```

```bash
cd apps/docs && bun dev
```

Site at `http://localhost:3000`. Content from `docs/` at project root.
