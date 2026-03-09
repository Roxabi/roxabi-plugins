/**
 * Fumadocs scaffolding — creates a docs app (apps/docs/) and root docs/ directory.
 * Generates template files based on the boilerplate structure.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FumadocsScaffoldResult {
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
  warnings: string[]
}

interface TemplateFile {
  relativePath: string
  content: string
}

function buildTemplates(): TemplateFile[] {
  return [
    {
      relativePath: 'apps/docs/source.config.ts',
      content: `import { defineDocs, defineConfig } from 'fumadocs-mdx/config'

export const docs = defineDocs({
  dir: '../../docs',
})

export default defineConfig({})
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
      relativePath: 'apps/docs/app/layout.tsx',
      content: `import { RootProvider } from 'fumadocs-ui/provider'
import type { ReactNode } from 'react'

const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL
const appUrl =
  rawAppUrl?.startsWith('https://') || rawAppUrl?.startsWith('http://') ? rawAppUrl : undefined

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>
          {appUrl && (
            <div className="flex h-9 items-center border-b px-4 text-xs text-muted-foreground">
              <a href={appUrl} className="hover:text-foreground transition-colors">
                &larr; Back to app
              </a>
            </div>
          )}
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
    <DocsLayout tree={source.pageTree} nav={{ title: 'Docs' }}>
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
        <MDX components={{ ...defaultMdxComponents }} />
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
      relativePath: 'apps/docs/package.json',
      content: `${JSON.stringify(
        {
          name: '@repo/docs',
          version: '0.1.0',
          private: true,
          scripts: {
            dev: 'next dev --port 3002',
            build: 'next build',
            start: 'next start',
            codegen: 'fumadocs-mdx',
            typecheck: 'tsc --noEmit',
          },
          dependencies: {
            'fumadocs-core': '^15.0.0',
            'fumadocs-ui': '^15.0.0',
            'fumadocs-mdx': '^11.0.0',
            next: '^15.0.0',
            react: '^19.0.0',
            'react-dom': '^19.0.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      relativePath: 'docs/index.mdx',
      content: `---
title: Introduction
description: Welcome to the documentation.
---

# Introduction

Welcome to the documentation. Add your content here.
`,
    },
    {
      relativePath: 'docs/meta.json',
      content: `${JSON.stringify(
        {
          title: 'Docs',
          pages: ['index'],
        },
        null,
        2,
      )}\n`,
    },
  ]
}

export async function scaffoldFumadocs(projectRoot: string): Promise<FumadocsScaffoldResult> {
  const result: FumadocsScaffoldResult = {
    dirsCreated: [],
    filesCreated: [],
    filesSkipped: [],
    warnings: [],
  }

  const dirs = ['apps/docs/app/docs/[[...slug]]', 'apps/docs/src/lib', 'docs']

  for (const dir of dirs) {
    const fullDir = join(projectRoot, dir)
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true })
      result.dirsCreated.push(dir)
    }
  }

  const templates = buildTemplates()

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
