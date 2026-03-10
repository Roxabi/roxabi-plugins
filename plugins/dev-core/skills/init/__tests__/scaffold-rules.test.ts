import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { expectedSections, scaffoldRules } from '../lib/scaffold-rules'

describe('scaffold-rules', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scaffold-rules-'))
    mkdirSync(join(tmp, '.claude'), { recursive: true })
  })

  function writeStack(content: string) {
    writeFileSync(join(tmp, '.claude', 'stack.yml'), content)
  }

  function writeClaudeMd(content: string) {
    writeFileSync(join(tmp, 'CLAUDE.md'), content)
  }

  describe('project type detection', () => {
    it('detects full-app when both backend and frontend have frameworks', () => {
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
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test-project',
      })
      expect(result.projectType).toBe('full-app')
    })

    it('detects backend-only when only backend has framework', () => {
      writeStack(`
runtime: bun
backend:
  framework: nestjs
  path: apps/api
frontend:
  framework: none
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'api-service',
      })
      expect(result.projectType).toBe('backend-only')
    })

    it('detects frontend-only when only frontend has framework', () => {
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: nextjs
  path: apps/web
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'web-app',
      })
      expect(result.projectType).toBe('frontend-only')
    })

    it('detects cli-library when both frameworks are none but runtime exists', () => {
      writeStack(`
runtime: bun
package_manager: bun
backend:
  framework: none
frontend:
  framework: none
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-cli',
      })
      expect(result.projectType).toBe('cli-library')
    })

    it('detects docs-content when only docs framework exists', () => {
      writeStack(`
backend:
  framework: none
frontend:
  framework: none
docs:
  framework: fumadocs
  path: docs
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'docs-site',
      })
      expect(result.projectType).toBe('docs-content')
    })

    it('detects stub when nothing is set', () => {
      writeStack(`
schema_version: "1.0"
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'new-project',
      })
      expect(result.projectType).toBe('stub')
    })
  })

  describe('section generation', () => {
    it('generates all 12 sections for full-app', () => {
      writeStack(`
runtime: bun
backend:
  framework: nestjs
frontend:
  framework: tanstack-start
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'full-app',
      })
      expect(result.sections).toHaveLength(12)
      expect(result.sections.map((s) => s.id)).toEqual([
        'tldr',
        'dev-process',
        'ask-user-question',
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
      writeStack(`
runtime: bun
backend:
  framework: none
frontend:
  framework: none
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-cli',
      })
      expect(result.sections.map((s) => s.id)).toEqual([
        'tldr',
        'dev-process',
        'ask-user-question',
        'git',
        'artifact-model',
        'coding-standards',
        'gotchas',
      ])
    })

    it('generates minimal sections for docs-content', () => {
      writeStack(`
backend:
  framework: none
frontend:
  framework: none
docs:
  framework: fumadocs
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'docs',
      })
      expect(result.sections.map((s) => s.id)).toEqual(['tldr', 'ask-user-question', 'git', 'gotchas'])
    })

    it('generates minimal sections for stub', () => {
      writeStack('schema_version: "1.0"\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'new',
      })
      expect(result.sections.map((s) => s.id)).toEqual(['tldr', 'ask-user-question', 'git'])
    })
  })

  describe('markdown output', () => {
    it('produces valid markdown with headings', () => {
      writeStack(`
runtime: bun
backend:
  framework: nestjs
frontend:
  framework: tanstack-start
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.markdown).toContain('## Critical Rules')
      expect(result.markdown).toContain('## TL;DR')
      expect(result.markdown).toContain('### 1. Dev Process')
      expect(result.markdown).toContain('### 5. Git')
      expect(result.markdown).toContain('## Gotchas')
    })

    it('includes project name in TL;DR', () => {
      writeStack('runtime: bun\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'my-awesome-project',
      })
      expect(result.markdown).toContain('**Project:** my-awesome-project')
    })

    it('uses artifact paths from stack.yml', () => {
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
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.markdown).toContain('`custom/frames/`')
      expect(result.markdown).toContain('`custom/analyses/`')
    })

    it('uses standards paths from stack.yml', () => {
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
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.markdown).toContain('docs/fe-patterns.mdx')
      expect(result.markdown).toContain('docs/be-patterns.mdx')
      expect(result.markdown).toContain('docs/review.mdx')
    })
  })

  describe('existing CLAUDE.md analysis', () => {
    it('detects existing sections', () => {
      writeStack('runtime: bun\n')
      writeClaudeMd(`@.claude/stack.yml

## TL;DR

Some content

### 2. AskUserQuestion

Always use it

### 5. Git

Commit rules
`)
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.existing.hasImport).toBe(true)
      expect(result.existing.sectionIds).toContain('tldr')
      expect(result.existing.sectionIds).toContain('ask-user-question')
      expect(result.existing.sectionIds).toContain('git')
    })

    it('detects missing import', () => {
      writeStack('runtime: bun\n')
      writeClaudeMd('# My Project\n\nSome content\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.existing.hasImport).toBe(false)
      expect(result.existing.sectionIds).toEqual([])
    })

    it('returns empty when CLAUDE.md does not exist', () => {
      writeStack('runtime: bun\n')
      const result = scaffoldRules({
        stackPath: join(tmp, '.claude', 'stack.yml'),
        claudeMdPath: join(tmp, 'nonexistent-CLAUDE.md'),
        projectName: 'test',
      })
      expect(result.existing.hasImport).toBe(false)
      expect(result.existing.sectionIds).toEqual([])
    })
  })

  describe('expectedSections', () => {
    it('returns full list for full-app', () => {
      const ids = expectedSections('full-app')
      expect(ids).toHaveLength(12)
      expect(ids).toContain('tldr')
      expect(ids).toContain('mandatory-worktree')
    })

    it('returns shorter list for cli-library', () => {
      const ids = expectedSections('cli-library')
      expect(ids).toHaveLength(7)
      expect(ids).not.toContain('mandatory-worktree')
      expect(ids).not.toContain('orchestrator-delegation')
    })

    it('returns minimal list for stub', () => {
      const ids = expectedSections('stub')
      expect(ids).toHaveLength(3)
    })
  })
})
