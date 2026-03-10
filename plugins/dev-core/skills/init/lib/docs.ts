/**
 * Docs scaffolding — copies template files from templates/docs/ into the project.
 *
 * Templates are real markdown files that can be previewed and edited directly.
 * They provide project-specific scaffolding that complements the universal
 * domain knowledge embedded in agent definitions (## Domain Reference).
 *
 * Agent embedded knowledge = universal (Clean Architecture, REST, WCAG — never changes)
 * docs/standards/ templates = project-specific (YOUR ORM, YOUR component library, YOUR CI)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface DocsScaffoldOpts {
  format: 'md' | 'mdx'
  path: string
}

export interface DocsScaffoldResult {
  docsPath: string
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
}

/** Resolve the templates/docs/ directory relative to this file's location. */
function getTemplatesDir(): string {
  // lib/docs.ts → ../templates/docs/
  return resolve(__dirname, '..', 'templates', 'docs')
}

/** Recursively collect all files in a directory, returning paths relative to root. */
function walkDir(dir: string, root?: string): string[] {
  const base = root ?? dir
  const entries: string[] = []

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      entries.push(...walkDir(full, base))
    } else {
      entries.push(relative(base, full))
    }
  }

  return entries
}

/**
 * Rename template extension if the target format differs.
 * Templates are stored as .md; if format is .mdx, rename the extension.
 */
function renameExt(relPath: string, format: 'md' | 'mdx'): string {
  if (format === 'mdx' && relPath.endsWith('.md')) {
    return relPath.replace(/\.md$/, '.mdx')
  }
  return relPath
}

export function scaffoldDocs(opts: DocsScaffoldOpts): DocsScaffoldResult {
  const { format, path: docsPath } = opts
  const templatesDir = getTemplatesDir()

  const result: DocsScaffoldResult = {
    docsPath,
    dirsCreated: [],
    filesCreated: [],
    filesSkipped: [],
  }

  if (!existsSync(templatesDir)) {
    return result
  }

  // Ensure standard directories exist (including adr/ which has no template files)
  const standardDirs = ['architecture', 'architecture/adr', 'standards', 'guides', 'processes']
  for (const dir of standardDirs) {
    const fullDir = join(docsPath, dir)
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true })
      result.dirsCreated.push(dir)
    }
  }

  // Walk templates and copy each file
  const templateFiles = walkDir(templatesDir)

  for (const relPath of templateFiles) {
    // Guard against path traversal (e.g. symlinks producing "../" relative paths)
    if (relPath.includes('..')) continue

    const targetRelPath = renameExt(relPath, format)
    const sourcePath = join(templatesDir, relPath)
    const targetPath = join(docsPath, targetRelPath)

    // Verify resolved path stays within docsPath boundary
    const resolvedTarget = resolve(targetPath)
    const resolvedBase = resolve(docsPath)
    if (!resolvedTarget.startsWith(resolvedBase + sep) && resolvedTarget !== resolvedBase) continue

    if (existsSync(targetPath)) {
      result.filesSkipped.push(targetRelPath)
      continue
    }

    // Ensure parent directory exists
    const parentDir = dirname(targetPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    const content = readFileSync(sourcePath, 'utf-8')
    writeFileSync(targetPath, content)
    result.filesCreated.push(targetRelPath)
  }

  return result
}
