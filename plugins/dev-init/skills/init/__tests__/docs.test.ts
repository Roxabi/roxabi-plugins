import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffoldDocs } from '../lib/docs'

describe('scaffoldDocs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'docs-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const EXPECTED_DIRS = ['architecture', 'architecture/adr', 'standards', 'guides', 'processes']

  const EXPECTED_TEMPLATE_FILES = [
    'architecture/index.md',
    'architecture/patterns.md',
    'architecture/ubiquitous-language.md',
    'standards/configuration.md',
    'contributing.md',
    'guides/deployment.md',
    'guides/troubleshooting.md',
    'processes/dev-process.md',
    'processes/issue-management.md',
    'standards/backend-patterns.md',
    'standards/code-review.md',
    'standards/frontend-patterns.md',
    'standards/testing.md',
  ]

  it('creates standard directories and copies all template files as .md', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert
    expect(result.docsPath).toBe(docsPath)
    expect(result.dirsCreated).toEqual(expect.arrayContaining(EXPECTED_DIRS))
    expect(result.filesCreated.length).toBe(EXPECTED_TEMPLATE_FILES.length)
    expect(result.filesSkipped).toEqual([])
    expect(result.filesCreated.every((f) => f.endsWith('.md'))).toBe(true)
    expect(result.filesCreated.some((f) => f.endsWith('.mdx'))).toBe(false)

    for (const file of EXPECTED_TEMPLATE_FILES) {
      expect(existsSync(join(docsPath, file))).toBe(true)
    }
  })

  it('ignores deprecated format option and still writes .md', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')

    // Act
    const result = scaffoldDocs({ format: 'mdx', path: docsPath })

    // Assert — non-empty + concrete paths (vacuous every/some on [] would pass)
    expect(result.filesCreated.length).toBeGreaterThan(0)
    expect(result.filesCreated).toContain('contributing.md')
    expect(result.filesCreated).not.toContain('contributing.mdx')
    expect(result.filesCreated.every((f) => f.endsWith('.md'))).toBe(true)
    expect(result.filesCreated.some((f) => f.endsWith('.mdx'))).toBe(false)
  })

  it('skips existing files without overwriting', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')
    mkdirSync(docsPath, { recursive: true })
    const existingFile = join(docsPath, 'contributing.md')
    writeFileSync(existingFile, 'custom content')

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert
    expect(result.filesSkipped).toContain('contributing.md')
    expect(result.filesCreated).not.toContain('contributing.md')
    expect(readFileSync(existingFile, 'utf-8')).toBe('custom content')
  })

  it('does not touch legacy .mdx files when scaffolding .md', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')
    mkdirSync(docsPath, { recursive: true })
    writeFileSync(join(docsPath, 'contributing.mdx'), 'legacy mdx')

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert — new .md is created alongside legacy .mdx
    expect(result.filesCreated).toContain('contributing.md')
    expect(readFileSync(join(docsPath, 'contributing.mdx'), 'utf-8')).toBe('legacy mdx')
  })

  it('creates adr/ directory even though no template maps to it', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert
    expect(result.dirsCreated).toContain('architecture/adr')
    expect(existsSync(join(docsPath, 'architecture', 'adr'))).toBe(true)
  })

  it('does not re-create directories that already exist', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')
    mkdirSync(join(docsPath, 'standards'), { recursive: true })

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert
    expect(result.dirsCreated).not.toContain('standards')
  })

  it('copies template content faithfully', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')

    // Act
    scaffoldDocs({ path: docsPath })

    // Assert
    const content = readFileSync(join(docsPath, 'contributing.md'), 'utf-8')
    expect(content).toContain('# Contributing')
    expect(content).toContain('## Commit Conventions')
  })

  it('handles nested template paths correctly', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert — files two levels deep are created with correct relative paths
    expect(result.filesCreated).toContain('standards/backend-patterns.md')
    expect(result.filesCreated).toContain('architecture/index.md')
    expect(existsSync(join(docsPath, 'standards', 'backend-patterns.md'))).toBe(true)
  })

  it('is idempotent — second run skips all files', () => {
    // Arrange
    const docsPath = join(tmpDir, 'docs')
    scaffoldDocs({ path: docsPath })

    // Act
    const result = scaffoldDocs({ path: docsPath })

    // Assert
    expect(result.filesCreated).toEqual([])
    expect(result.filesSkipped.length).toBe(EXPECTED_TEMPLATE_FILES.length)
    expect(result.dirsCreated).toEqual([])
  })
})
