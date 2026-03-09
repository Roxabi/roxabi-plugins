import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { scaffoldFumadocs } from '../lib/fumadocs'

const EXPECTED_DIRS = ['apps/docs/app/docs/[[...slug]]', 'apps/docs/src/lib', 'docs']

const EXPECTED_FILES = [
  'apps/docs/source.config.ts',
  'apps/docs/next.config.ts',
  'apps/docs/src/lib/source.ts',
  'apps/docs/app/layout.tsx',
  'apps/docs/app/page.tsx',
  'apps/docs/app/docs/layout.tsx',
  'apps/docs/app/docs/[[...slug]]/page.tsx',
  'apps/docs/package.json',
  'docs/index.mdx',
  'docs/meta.json',
]

describe('scaffoldFumadocs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fumadocs-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates all expected directories and files', async () => {
    // Arrange
    // (temp dir already exists, no pre-existing files)

    // Act
    const result = await scaffoldFumadocs(tmpDir)

    // Assert — all expected files are in filesCreated
    for (const file of EXPECTED_FILES) {
      expect(result.filesCreated, `expected ${file} to be created`).toContain(file)
    }

    // All expected dirs appear in dirsCreated
    for (const dir of EXPECTED_DIRS) {
      expect(result.dirsCreated, `expected ${dir} to be created`).toContain(dir)
    }

    // Nothing should be skipped on a clean run
    expect(result.filesSkipped).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('skips a file that already exists (additive-only)', async () => {
    // Arrange — create the package.json before scaffolding
    const packageJsonRel = 'apps/docs/package.json'
    const packageJsonAbs = join(tmpDir, packageJsonRel)
    mkdirSync(join(tmpDir, 'apps/docs'), { recursive: true })
    writeFileSync(packageJsonAbs, JSON.stringify({ name: 'pre-existing' }))

    // Act
    const result = await scaffoldFumadocs(tmpDir)

    // Assert — pre-existing file is in filesSkipped, not filesCreated
    expect(result.filesSkipped).toContain(packageJsonRel)
    expect(result.filesCreated).not.toContain(packageJsonRel)

    // Other files should still be created
    expect(result.filesCreated).toContain('docs/index.mdx')
    expect(result.filesCreated).toContain('apps/docs/source.config.ts')
  })

  it('returns a warning for each skipped file', async () => {
    // Arrange — create two files in advance
    const file1Rel = 'docs/index.mdx'
    const file2Rel = 'docs/meta.json'
    mkdirSync(join(tmpDir, 'docs'), { recursive: true })
    writeFileSync(join(tmpDir, file1Rel), '# existing')
    writeFileSync(join(tmpDir, file2Rel), '{}')

    // Act
    const result = await scaffoldFumadocs(tmpDir)

    // Assert — one warning per skipped file
    expect(result.warnings).toHaveLength(2)

    const warningText = result.warnings.join('\n')
    expect(warningText).toContain(file1Rel)
    expect(warningText).toContain(file2Rel)
  })

  it('omits pre-existing dirs from dirsCreated', async () => {
    // Arrange — create the docs dir in advance
    mkdirSync(join(tmpDir, 'docs'), { recursive: true })

    // Act
    const result = await scaffoldFumadocs(tmpDir)

    // Assert — pre-existing dir not in dirsCreated
    expect(result.dirsCreated).not.toContain('docs')
    // Other dirs still created
    expect(result.dirsCreated).toContain('apps/docs/src/lib')
    // No error — scaffold still completes
    expect(result.filesCreated.length).toBeGreaterThan(0)
  })

  it('uses projectRoot as the base path, not process.cwd()', async () => {
    // Arrange — a second temp dir that is not cwd
    const anotherTmpDir = mkdtempSync(join(tmpdir(), 'fumadocs-cwd-test-'))

    try {
      // Act
      const result = await scaffoldFumadocs(anotherTmpDir)

      // Assert — files were created relative to anotherTmpDir
      expect(result.filesCreated.length).toBeGreaterThan(0)
      // Nothing should land in cwd
      expect(result.filesCreated).toContain('docs/index.mdx')
      expect(existsSync(join(anotherTmpDir, 'docs/index.mdx'))).toBe(true)
      // Also verify files did NOT land in tmpDir (the outer temp dir)
      expect(existsSync(join(tmpDir, 'docs/index.mdx'))).toBe(false)
    } finally {
      rmSync(anotherTmpDir, { recursive: true, force: true })
    }
  })
})
