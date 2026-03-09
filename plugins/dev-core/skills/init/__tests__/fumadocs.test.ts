import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffoldFumadocs } from '../lib/fumadocs'

describe('scaffoldFumadocs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fumadocs-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const EXPECTED_DIRS = [
    'apps/docs/app/docs/[[...slug]]',
    'apps/docs/src/lib',
    'apps/docs/src/components/mdx',
    'docs',
  ]

  const EXPECTED_FILES = [
    'apps/docs/source.config.ts',
    'apps/docs/next.config.ts',
    'apps/docs/postcss.config.mjs',
    'apps/docs/globals.css',
    'apps/docs/mdx-components.tsx',
    'apps/docs/tsconfig.json',
    'apps/docs/package.json',
    'apps/docs/src/lib/source.ts',
    'apps/docs/src/lib/shiki.ts',
    'apps/docs/src/components/mdx/Mermaid.tsx',
    'apps/docs/app/layout.tsx',
    'apps/docs/app/page.tsx',
    'apps/docs/app/docs/layout.tsx',
    'apps/docs/app/docs/[[...slug]]/page.tsx',
    'docs/index.mdx',
    'docs/meta.json',
  ]

  describe('creates all expected dirs', () => {
    it('creates all 4 required directories', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      for (const dir of EXPECTED_DIRS) {
        const fullPath = join(tmpDir, dir)
        expect(fullPath, `Expected dir to exist: ${dir}`).toSatisfy((p: string) => {
          const { existsSync } = require('node:fs')
          return existsSync(p)
        })
      }
    })
  })

  describe('creates all expected files', () => {
    it('creates all 16 expected files', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      for (const file of EXPECTED_FILES) {
        const fullPath = join(tmpDir, file)
        expect(fullPath, `Expected file to exist: ${file}`).toSatisfy((p: string) => {
          const { existsSync } = require('node:fs')
          return existsSync(p)
        })
      }
    })
  })

  describe('returns correct result counts', () => {
    it('returns filesCreated=16, filesSkipped=0, warnings=0, dirsCreated=4 on first call', () => {
      // Arrange + Act
      const result = scaffoldFumadocs(tmpDir)

      // Assert
      expect(result.filesCreated.length).toBe(16)
      expect(result.filesSkipped.length).toBe(0)
      expect(result.warnings.length).toBe(0)
      expect(result.dirsCreated.length).toBe(4)
    })
  })

  describe('additive-only: skips existing files', () => {
    it('second call returns filesSkipped=16, filesCreated=0, warnings=16', () => {
      // Arrange
      scaffoldFumadocs(tmpDir)

      // Act
      const secondResult = scaffoldFumadocs(tmpDir)

      // Assert
      expect(secondResult.filesSkipped.length).toBe(16)
      expect(secondResult.filesCreated.length).toBe(0)
      expect(secondResult.warnings.length).toBe(16)
    })
  })

  describe('additive-only: partial skip', () => {
    it('pre-existing file appears in filesSkipped and not in filesCreated', () => {
      // Arrange — create the docs directory and one file manually before scaffolding
      const { mkdirSync } = require('node:fs')
      const preExistingRelPath = 'docs/index.mdx'
      const preExistingFullPath = join(tmpDir, preExistingRelPath)
      mkdirSync(join(tmpDir, 'docs'), { recursive: true })
      writeFileSync(preExistingFullPath, '# Pre-existing content\n', 'utf8')

      // Act
      const result = scaffoldFumadocs(tmpDir)

      // Assert
      expect(result.filesSkipped).toContain(preExistingRelPath)
      expect(result.filesCreated).not.toContain(preExistingRelPath)
      expect(result.filesCreated.length).toBe(15)
      expect(result.filesSkipped.length).toBe(1)
      expect(result.warnings.length).toBe(1)
    })
  })

  describe('content spot-checks', () => {
    it('apps/docs/app/layout.tsx contains https://roxabi.com', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      const content = readFileSync(join(tmpDir, 'apps/docs/app/layout.tsx'), 'utf8')
      expect(content).toContain('https://roxabi.com')
    })

    it('apps/docs/package.json is valid JSON with a fumadocs-ui dependency', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      const raw = readFileSync(join(tmpDir, 'apps/docs/package.json'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed).toBeDefined()
      expect(parsed.dependencies).toHaveProperty('fumadocs-ui')
    })

    it('docs/meta.json is valid JSON with pages array containing "index"', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      const raw = readFileSync(join(tmpDir, 'docs/meta.json'), 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed).toBeDefined()
      expect(Array.isArray(parsed.pages)).toBe(true)
      expect(parsed.pages).toContain('index')
    })

    it('apps/docs/src/lib/shiki.ts contains experimentalJSEngine', () => {
      // Arrange + Act
      scaffoldFumadocs(tmpDir)

      // Assert
      const content = readFileSync(join(tmpDir, 'apps/docs/src/lib/shiki.ts'), 'utf8')
      expect(content).toContain('experimentalJSEngine')
    })
  })
})
