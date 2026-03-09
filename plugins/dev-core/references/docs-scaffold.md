# Fumadocs Scaffold Reference

When `docs.framework: fumadocs` is set in `.claude/stack.yml`, `/init` Phase 7 generates a full Fumadocs documentation site. The scaffold is split across two directories: `apps/docs/` (Next.js application) and `docs/` (MDX content).

## Fumadocs Scaffold Convention

`scaffoldFumadocs()` in `lib/fumadocs.ts` is the implementation. `/init` Phase 7 calls it after reading `docs.framework` from stack.yml. The function is additive-only — it never overwrites existing files.

The scaffold produces a working documentation site out of the box: Mermaid diagrams, syntax highlighting via Shiki, dark/light theme switching, and a root navigation file ready for Fumadocs' `meta.json` convention.

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

## Required Packages (installed in apps/docs/)

| Package | Version | Notes |
|---------|---------|-------|
| fumadocs-ui | ^15.4.2 | UI components and layouts |
| fumadocs-core | ^15.4.2 | Core loader and plugins |
| fumadocs-mdx | ^11.6.7 | MDX processing |
| next | ^15.3.4 | Next.js app |
| react / react-dom | ^19.2.4 | React |
| mermaid | ^11.4.1 | Diagram rendering |
| dompurify | ^3.3.2 | SVG sanitization for Mermaid |
| next-themes | ^0.4.6 | Theme switching for Mermaid |
| shiki | ^3.4.0 | Syntax highlighting |
| tailwindcss | ^4.1.0 | Styling |
| @tailwindcss/postcss (dev) | ^4.1.0 | Tailwind v4 PostCSS plugin |
| @types/dompurify (dev) | ^3.2.0 | DOMPurify type definitions |
| @types/mdx (dev) | ^2.0.13 | MDX type definitions |

## Key Design Decisions

- **`@/*` path alias** maps to `./src/*` via `tsconfig.json` paths — keeps imports clean across all files under `src/`.
- **`@/.source`** maps to `.source/index.ts`, the codegen output produced by `fumadocs-mdx` at build time. This is the only non-`src/` alias.
- **Mermaid** is rendered client-side via a custom `Mermaid.tsx` component. `remarkMdxMermaid` (from `fumadocs-core`) extracts code blocks at build time; the component calls `mermaid.render()` and sanitizes the output SVG with DOMPurify before injecting it into the DOM. `next-themes` is used to pick the correct Mermaid theme (`neutral` vs `dark`) at render time.
- **Shiki** uses `experimentalJSEngine` to avoid OOM crashes on CI runners. Dual themes are configured: one for light mode, one for dark mode.
- **Back-link** in `app/layout.tsx` reads `process.env.NEXT_PUBLIC_APP_URL ?? 'https://roxabi.com'` — set this env var to point to your main application.
- **`output: standalone`** in `next.config.ts` produces a self-contained build suitable for Docker and Railway deployments.

## Additive-Only Rule

If a file already exists at any of the scaffold paths, `scaffoldFumadocs()` skips that file and emits a warning to stdout. It never overwrites existing content. This makes the scaffold safe to re-run after partial scaffolding or manual edits.

## Running the Scaffold

Set the following in `.claude/stack.yml`:

```yaml
docs:
  framework: fumadocs
  path: docs
  format: mdx
```

Then run `/init` — Phase 7 detects `docs.framework: fumadocs` and offers to scaffold. Confirm to proceed.

To trigger the scaffold directly without the full `/init` flow:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs --root <project-root>
```

After scaffolding, install dependencies in the docs app:

```bash
cd apps/docs && bun install
```

Then start the dev server:

```bash
cd apps/docs && bun dev
```

The docs site will be available at `http://localhost:3000`. Content is read from `docs/` at the project root.
