/**
 * Fumadocs scaffolding — creates a full Fumadocs Next.js app at apps/docs/
 * and a content directory at docs/, matching the production boilerplate.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FumadocsScaffoldResult {
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
  warnings: string[]
}

export interface FumadocsVercelResult {
  file: string
  created: boolean
  skipped: boolean
}

interface TemplateFile {
  relativePath: string
  content: string
}

function buildTemplates(docsPath: string): TemplateFile[] {
  return [
    {
      relativePath: 'apps/docs/source.config.ts',
      content: `import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins'
import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { shikiOptions } from './src/lib/shiki'

export const docs = defineDocs({
  dir: '../../${docsPath}',
})

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid],
    rehypeCodeOptions: shikiOptions,
  },
})
`,
    },
    {
      relativePath: 'apps/docs/next.config.ts',
      content: `import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

const withMDX = createMDX()

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
}

export default withMDX(config)
`,
    },
    {
      relativePath: 'apps/docs/postcss.config.mjs',
      content: `export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
`,
    },
    {
      relativePath: 'apps/docs/globals.css',
      content: `@import 'tailwindcss';
@import 'fumadocs-ui/css/preset.css';
@import 'fumadocs-ui/css/neutral.css';
`,
    },
    {
      relativePath: 'apps/docs/mdx-components.tsx',
      content: `import defaultMdxComponents from 'fumadocs-ui/mdx'
import type { MDXComponents } from 'mdx/types'
import { Mermaid } from '@/components/mdx/Mermaid'

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Mermaid,
    ...components,
  }
}
`,
    },
    {
      relativePath: 'apps/docs/tsconfig.json',
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"],
      "@/.source": ["./.source/index.ts"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".source/**/*.ts"],
  "exclude": ["node_modules"]
}
`,
    },
    {
      relativePath: 'apps/docs/package.json',
      content: `{
  "name": "@repo/docs",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev --port 3002",
    "build": "next build",
    "start": "next start",
    "codegen": "fumadocs-mdx",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .next .turbo .source"
  },
  "dependencies": {
    "dompurify": "^3.3.2",
    "fumadocs-core": "^15.4.2",
    "fumadocs-mdx": "^11.6.7",
    "fumadocs-ui": "^15.4.2",
    "mermaid": "^11.4.1",
    "next": "^15.3.4",
    "next-themes": "^0.4.6",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "shiki": "^3.4.0",
    "tailwindcss": "^4.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.0",
    "@types/mdx": "^2.0.13",
    "@types/dompurify": "^3.2.0",
    "@types/node": "^24.11.0",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "typescript": "^5.9.3"
  }
}
`,
    },
    {
      relativePath: 'apps/docs/src/lib/source.ts',
      content: `import { loader } from 'fumadocs-core/source'
import { createMDXSource } from 'fumadocs-mdx'
import { docs } from '@/.source'

// createMDXSource gives proper generic types (body, toc, etc.) for page.data inference.
// fumadocs-mdx@11 returns \`files\` as a lazy function at runtime; fumadocs-core@15 requires
// a plain array. Unwrap it here.
const _mdxSource = createMDXSource(docs.docs, docs.meta)
type SourceFiles = (typeof _mdxSource)['files']
// @ts-expect-error — files is a function at runtime despite being typed as VirtualFile[]
const files: SourceFiles = _mdxSource.files()

export const source = loader({
  baseUrl: '/docs',
  source: { ..._mdxSource, files },
})
`,
    },
    {
      relativePath: 'apps/docs/src/lib/shiki.ts',
      content: `import type { RehypeCodeOptions } from 'fumadocs-core/mdx-plugins'

/**
 * Shiki configuration for fumadocs-core's rehypeCode plugin.
 *
 * Uses the JS regex engine (experimentalJSEngine) and limits bundled languages
 * to avoid OOM errors on CI. Dual themes (light/dark) are provided via
 * GitHub's built-in themes included in the shiki bundle.
 */
export const shikiOptions = {
  // JS engine avoids Oniguruma WASM OOM on CI; trades tokenisation fidelity for memory safety
  experimentalJSEngine: true,
  themes: {
    light: 'github-light',
    dark: 'github-dark',
  },
  langs: [
    'typescript',
    'tsx',
    'javascript',
    'jsx',
    'bash',
    'shellscript',
    'json',
    'jsonc',
    'yaml',
    'sql',
    'toml',
    'markdown',
    'mdx',
    'css',
    'html',
    'diff',
    'docker',
    'ini',
    'graphql',
    'prisma',
  ],
} satisfies RehypeCodeOptions
`,
    },
    {
      relativePath: 'apps/docs/src/components/mdx/Mermaid.tsx',
      content: `'use client'

import { useTheme } from 'next-themes'
import { useEffect, useId, useState } from 'react'

type MermaidProps = {
  chart: string
}

type RenderResult = { success: true; svg: string } | { success: false; error: string }

let lastInitializedTheme: string | undefined

async function ensureMermaidInitialized(
  theme: string | undefined
): Promise<typeof import('mermaid')['default'] | null> {
  if (typeof window === 'undefined') return null
  const mermaid = (await import('mermaid')).default
  const mermaidTheme = theme === 'dark' ? 'dark' : 'default'
  if (lastInitializedTheme !== mermaidTheme) {
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme, suppressErrorRendering: true })
    lastInitializedTheme = mermaidTheme
  }
  return mermaid
}

async function renderMermaidChart(
  containerId: string,
  chart: string,
  theme: string | undefined
): Promise<RenderResult> {
  try {
    const mermaid = await ensureMermaidInitialized(theme)
    if (!mermaid) return { success: true, svg: '' }
    const { svg } = await mermaid.render(containerId, chart)
    // SVG output from mermaid is sanitized with DOMPurify before rendering
    const DOMPurify = (await import('dompurify')).default
    const cleanSvg = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['foreignObject'],
    })
    return { success: true, svg: cleanSvg }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to render Mermaid diagram'
    return { success: false, error: message }
  }
}

function Mermaid({ chart }: MermaidProps) {
  const id = useId()
  const containerId = \`mermaid-\${id.replace(/:/g, '')}\`
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    if (!chart) return
    let cancelled = false
    renderMermaidChart(containerId, chart, resolvedTheme).then((result) => {
      if (cancelled) return
      if (result.success) {
        setSvg(result.svg)
        setError('')
      } else {
        setError(result.error)
        setSvg('')
      }
    })
    return () => {
      cancelled = true
    }
    // containerId is stable (derived from useId) — listed for exhaustive-deps
  }, [chart, containerId, resolvedTheme])

  if (error) {
    return (
      <div
        role="alert"
        className="my-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
      >
        <p className="mb-1 font-medium">Mermaid diagram error</p>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{error}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: <output> is not appropriate for a loading placeholder; role="status" is intentional
      <div
        role="status"
        aria-label="Loading diagram"
        className="my-4 flex items-center justify-center rounded-lg border p-8 text-sm text-muted-foreground"
      >
        Loading diagram...
      </div>
    )
  }

  // svg is DOMPurify-sanitized before being stored in state — safe to render
  return (
    <div
      className="my-4 flex justify-center [&>svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify above
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

export { Mermaid }
export type { MermaidProps }
`,
    },
    {
      relativePath: 'apps/docs/app/layout.tsx',
      content: `import { RootProvider } from 'fumadocs-ui/provider'
import type { ReactNode } from 'react'
import '../globals.css'

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://roxabi.com'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>
          <div className="flex h-9 items-center border-b px-4 text-xs text-muted-foreground">
            <a href={appUrl} className="hover:text-foreground transition-colors">
              &larr; Back to app
            </a>
          </div>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
`,
    },
    {
      relativePath: 'apps/docs/app/page.tsx',
      content: `import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/docs')
}
`,
    },
    {
      relativePath: 'apps/docs/app/docs/layout.tsx',
      content: `import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.pageTree} nav={{ title: 'Roxabi Docs' }}>
      {children}
    </DocsLayout>
  )
}
`,
    },
    {
      relativePath: 'apps/docs/app/docs/[[...slug]]/page.tsx',
      content: `import defaultMdxComponents from 'fumadocs-ui/mdx'
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page'
import { notFound } from 'next/navigation'
import { Mermaid } from '@/components/mdx/Mermaid'
import { source } from '@/lib/source'

interface PageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) notFound()

  const MDX = page.data.body

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Mermaid }} />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) notFound()

  return {
    title: page.data.title,
    description: page.data.description,
  }
}
`,
    },
    {
      relativePath: `${docsPath}/index.mdx`,
      content: `# Documentation

Welcome to the project documentation.
`,
    },
    {
      relativePath: `${docsPath}/meta.json`,
      content: `{ "title": "Docs", "pages": ["index"] }
`,
    },
  ]
}

export function scaffoldFumadocs(projectRoot: string, docsPath = 'docs'): FumadocsScaffoldResult {
  const DIRS_TO_CREATE = [
    'apps/docs/app/docs/[[...slug]]',
    'apps/docs/src/lib',
    'apps/docs/src/components/mdx',
    docsPath,
  ]
  const result: FumadocsScaffoldResult = {
    dirsCreated: [],
    filesCreated: [],
    filesSkipped: [],
    warnings: [],
  }

  for (const dir of DIRS_TO_CREATE as string[]) {
    const fullDir = join(projectRoot, dir)
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true })
      result.dirsCreated.push(dir)
    }
  }

  const templates = buildTemplates(docsPath)

  for (const tpl of templates) {
    const fullPath = join(projectRoot, tpl.relativePath)
    if (existsSync(fullPath)) {
      result.filesSkipped.push(tpl.relativePath)
      result.warnings.push(`Skipped existing file: ${tpl.relativePath}`)
    } else {
      writeFileSync(fullPath, tpl.content, 'utf8')
      result.filesCreated.push(tpl.relativePath)
    }
  }

  return result
}

/**
 * Scaffold apps/docs/vercel.json for Vercel deployment.
 * Conditional on deploy.platform == vercel in stack.yml.
 * Uses turbo-ignore when build.orchestrator == turbo, plain bun otherwise.
 */
export function scaffoldFumadocsVercel(
  projectRoot: string,
  orchestrator: string,
): FumadocsVercelResult {
  const file = 'apps/docs/vercel.json'
  const fullPath = join(projectRoot, file)

  if (existsSync(fullPath)) {
    return { file, created: false, skipped: true }
  }

  const isTurbo = orchestrator === 'turbo'
  const content = isTurbo
    ? JSON.stringify(
        {
          $schema: 'https://openapi.vercel.sh/vercel.json',
          ignoreCommand:
            '[ "$VERCEL_GIT_COMMIT_REF" != "main" ] || npx turbo-ignore @repo/docs',
          installCommand: 'bun install --ignore-scripts',
          buildCommand: 'turbo run build --filter=@repo/docs',
        },
        null,
        2,
      ) + '\n'
    : JSON.stringify(
        {
          $schema: 'https://openapi.vercel.sh/vercel.json',
          installCommand: 'bun install --ignore-scripts',
          buildCommand: 'cd apps/docs && bun run build',
        },
        null,
        2,
      ) + '\n'

  mkdirSync(join(projectRoot, 'apps/docs'), { recursive: true })
  writeFileSync(fullPath, content, 'utf8')
  return { file, created: true, skipped: false }
}
