import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expectedSections, scaffoldRules } from '../lib/scaffold-rules'

describe('scaffold-rules', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scaffold-rules-'))
    mkdirSync(join(tmp, '.claude'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeStack(content: string) {
    writeFileSync(join(tmp, '.claude', 'stack.yml'), content)
  }

  function writeClaudeMd(content: string) {
    writeFileSync(join(tmp, 'CLAUDE.md'), content)
  }

  describe('project type detection', () => {
    it('detects full-app when both backend and frontend have frameworks', () => {
      // Arrange
      writeStack(`
runtime: bun
package_manager: bun
backend:
  framework: nestjs
  path: apps/api
frontend:
  framework: tanstack-start
  path: apps/web
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test-project',
      })

      // Assert
      expect(result.projectType).toBe('full-app')
    })

    it('detects backend-only when only backend has framework', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: nestjs
  path: apps/api
frontend:
  framework: none
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'api-service',
      })

      // Assert
      expect(result.projectType).toBe('backend-only')
    })

    it('detects frontend-only when only frontend has framework', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: nextjs
  path: apps/web
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'web-app',
      })

      // Assert
      expect(result.projectType).toBe('frontend-only')
    })

    it('detects cli-library when both frameworks are none but runtime exists', () => {
      // Arrange
      writeStack(`
runtime: bun
package_manager: bun
backend:
  framework: none
frontend:
  framework: none
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-cli',
      })

      // Assert
      expect(result.projectType).toBe('cli-library')
    })

    it('detects docs-content when only docs framework exists', () => {
      // Arrange
      writeStack(`
backend:
  framework: none
frontend:
  framework: none
docs:
  framework: fumadocs
  path: docs
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'docs-site',
      })

      // Assert
      expect(result.projectType).toBe('docs-content')
    })

    it('detects stub when nothing is set', () => {
      // Arrange
      writeStack(`
schema_version: "1.0"
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'new-project',
      })

      // Assert
      expect(result.projectType).toBe('stub')
    })
  })

  describe('section generation', () => {
    it('generates all 12 sections for full-app', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: nestjs
frontend:
  framework: tanstack-start
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'full-app',
      })

      // Assert
      expect(result.sections).toHaveLength(11)
      expect(result.sections.map((s) => s.id)).toEqual([
        'tldr',
        'dev-process',
        'orchestrator-delegation',
        'parallel-execution',
        'git',
        'artifact-model',
        'mandatory-worktree',
        'code-review',
        'coding-standards',
        'skills-agents',
        'gotchas',
      ])
    })

    it('generates fewer sections for cli-library', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: none
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-cli',
      })

      // Assert
      expect(result.sections.map((s) => s.id)).toEqual([
        'tldr',
        'dev-process',
        'git',
        'artifact-model',
        'coding-standards',
        'gotchas',
      ])
    })

    it('generates minimal sections for docs-content', () => {
      // Arrange
      writeStack(`
backend:
  framework: none
frontend:
  framework: none
docs:
  framework: fumadocs
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'docs',
      })

      // Assert
      expect(result.sections.map((s) => s.id)).toEqual(['tldr', 'git', 'gotchas'])
    })

    it('generates minimal sections for stub', () => {
      // Arrange + Act
      writeStack('schema_version: "1.0"\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'new',
      })

      // Assert
      expect(result.sections.map((s) => s.id)).toEqual(['tldr', 'git'])
    })
  })

  describe('markdown output', () => {
    it('produces valid markdown with headings', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: nestjs
frontend:
  framework: tanstack-start
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.markdown).toContain('## TL;DR')
      expect(result.markdown).toContain('### 1. Dev Process')
      expect(result.markdown).toContain('### 4. Git')
      expect(result.markdown).toContain('## Gotchas')
    })

    it('numbers sections sequentially without gaps for cli-library', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: none
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-cli',
      })

      // Assert — cli-library skips orchestrator-delegation and parallel-execution
      expect(result.markdown).toContain('### 1. Dev Process')
      expect(result.markdown).toContain('### 2. Git')
      expect(result.markdown).toContain('### 3. Artifact Model')
      expect(result.markdown).toContain('### 4. Coding Standards')
      // No gaps
      expect(result.markdown).not.toContain('### 5.')
    })

    it('includes project name in TL;DR', () => {
      // Arrange + Act
      writeStack('runtime: bun\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-awesome-project',
      })

      // Assert
      expect(result.markdown).toContain('**Project:** my-awesome-project')
    })

    it('uses artifact paths from stack.yml', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: none
artifacts:
  frames: custom/frames
  analyses: custom/analyses
  specs: custom/specs
  plans: custom/plans
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.markdown).toContain('`custom/frames/`')
      expect(result.markdown).toContain('`custom/analyses/`')
    })

    it('uses standards paths from stack.yml', () => {
      // Arrange
      writeStack(`
runtime: bun
backend:
  framework: nestjs
frontend:
  framework: nextjs
standards:
  frontend: docs/fe-patterns.mdx
  backend: docs/be-patterns.mdx
  testing: docs/tests.mdx
  code_review: docs/review.mdx
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.markdown).toContain('docs/fe-patterns.mdx')
      expect(result.markdown).toContain('docs/be-patterns.mdx')
      expect(result.markdown).toContain('docs/review.mdx')
    })
  })

  describe('existing CLAUDE.md analysis', () => {
    it('detects existing sections', () => {
      // Arrange
      writeStack('runtime: bun\n')
      writeClaudeMd(`@.claude/stack.yml

## TL;DR

Some content

### 2. Decision Presentation

Use DP(n) protocol

### 5. Git

Commit rules
`)

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.existing.hasImport).toBe(true)
      expect(result.existing.sectionIds).toContain('tldr')
      expect(result.existing.sectionIds).toContain('decision-presentation')
      expect(result.existing.sectionIds).toContain('git')
    })

    it('detects missing import', () => {
      // Arrange
      writeStack('runtime: bun\n')
      writeClaudeMd('# My Project\n\nSome content\n')

      // Act
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.existing.hasImport).toBe(false)
      expect(result.existing.sectionIds).toEqual([])
    })

    it('returns empty when CLAUDE.md does not exist', () => {
      // Arrange + Act
      writeStack('runtime: bun\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'nonexistent-CLAUDE.md'),
        projectName: 'test',
      })

      // Assert
      expect(result.existing.hasImport).toBe(false)
      expect(result.existing.sectionIds).toEqual([])
    })
  })

  describe('expectedSections', () => {
    it('returns full list for full-app', () => {
      // Act
      const ids = expectedSections('full-app')

      // Assert
      expect(ids).toHaveLength(11)
      expect(ids).toContain('tldr')
      expect(ids).toContain('mandatory-worktree')
    })

    it('returns shorter list for cli-library', () => {
      // Act
      const ids = expectedSections('cli-library')

      // Assert
      expect(ids).toHaveLength(6)
      expect(ids).not.toContain('mandatory-worktree')
      expect(ids).not.toContain('orchestrator-delegation')
    })

    it('returns minimal list for stub', () => {
      // Act
      const ids = expectedSections('stub')

      // Assert
      expect(ids).toHaveLength(2)
    })
  })
})
