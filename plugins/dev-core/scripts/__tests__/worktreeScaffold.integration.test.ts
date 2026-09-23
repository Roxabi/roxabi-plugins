import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeScript, type ProjectContext, parseChecklist, selectConcerns } from '../worktreeScaffold'

// ─── Paths ───────────────────────────────────────────────────────────────────

const FIXTURES = path.join(import.meta.dirname, '__fixtures__')
const REFERENCES = path.join(import.meta.dirname, '../../references')
const REAL_CHECKLIST = path.join(REFERENCES, 'worktree-setup-checklist.md')
const BUN_FIXTURE = path.join(FIXTURES, 'checklist-bun.md')

// ─── Tool availability (module-level, for skipIf) ────────────────────────────

const shellcheckAvailable: boolean = (() => {
  try {
    execSync('command -v shellcheck', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// ─── Contexts ────────────────────────────────────────────────────────────────

const CTX_PYTHON_UV: ProjectContext = {
  runtime: 'python',
  package_manager: 'uv',
  monorepo: false,
  hooks_tool: 'lefthook',
  env_files: ['.env'],
  database: 'none',
  backend_paths: [],
}

const CTX_BUN_NEON_MONOREPO: ProjectContext = {
  runtime: 'bun',
  package_manager: 'bun',
  monorepo: true,
  hooks_tool: 'lefthook',
  env_files: ['.env'],
  database: 'neon',
  backend_paths: ['apps/api'],
}

// ─── parseChecklist ──────────────────────────────────────────────────────────

describe('parseChecklist', () => {
  it('test_parse_schema_real_checklist', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    expect(checklist.concerns).toHaveLength(6)
    for (const concern of checklist.concerns) {
      expect(concern.id).toBeTruthy()
      expect(Array.isArray(concern.applies_when)).toBe(true)
      expect(concern.setup_snippet).toBeTruthy()
      expect(concern.teardown_snippet).toBeTruthy()
      expect(concern.validation).toBeTruthy()
    }
  })

  it('test_parse_throws_on_missing_field', () => {
    expect(() => parseChecklist(BUN_FIXTURE)).toThrow()
    try {
      parseChecklist(BUN_FIXTURE)
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toMatch(/missing field|validation/)
    }
  })
})

// ─── selectConcerns ──────────────────────────────────────────────────────────

describe('selectConcerns', () => {
  it('test_select_python_uv', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_PYTHON_UV, checklist)
    const ids = new Set(selected.map((c) => c.id))

    expect(ids).toContain('env-files')
    expect(ids).toContain('uv-venv-symlink')
    expect(ids).toContain('lefthook-hookspath-fix')

    expect(ids).not.toContain('bun-install-warmup')
    expect(ids).not.toContain('npm-install-warmup')
    expect(ids).not.toContain('neon-db-branch')
  })

  it('test_select_bun_neon_monorepo', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_BUN_NEON_MONOREPO, checklist)
    const ids = new Set(selected.map((c) => c.id))

    expect(ids).toContain('env-files')
    expect(ids).toContain('bun-install-warmup')
    expect(ids).toContain('lefthook-hookspath-fix')
    expect(ids).toContain('neon-db-branch')

    expect(ids).not.toContain('uv-venv-symlink')
    expect(ids).not.toContain('npm-install-warmup')
  })
})

// ─── composeScript ───────────────────────────────────────────────────────────

describe('composeScript', () => {
  it('test_compose_setup_structure', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_PYTHON_UV, checklist)
    const script = composeScript(selected, 'setup')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash/)
    expect(script).toContain('set -euo pipefail')
    for (const concern of selected) {
      expect(script).toContain(`# ─── ${concern.id}`)
    }
    expect(script).toMatch(/\n$/)
  })

  it('test_compose_teardown_structure', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_PYTHON_UV, checklist)
    const script = composeScript(selected, 'teardown')

    expect(script).toMatch(/^#!\/usr\/bin\/env bash/)
    expect(script).toContain('set -euo pipefail')
    for (const concern of selected) {
      expect(script).toContain(`# ─── ${concern.id}`)
    }
    expect(script).toMatch(/\n$/)

    const uvConcern = selected.find((c) => c.id === 'uv-venv-symlink')
    expect(uvConcern).toBeDefined()
    expect(script).toMatch(/\[ -L \.venv \].*rm \.venv|rm \.venv/)
  })
})

// ─── shellcheck (optional — skipped when shellcheck is not installed) ─────────

describe('shellcheck', () => {
  it.skipIf(!shellcheckAvailable)('test_compose_shellcheck_python', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_PYTHON_UV, checklist)
    const script = composeScript(selected, 'setup')
    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // shellcheck emits nothing to stdout when the script is clean
    expect(result).toBe('')
  })

  it.skipIf(!shellcheckAvailable)('test_compose_shellcheck_bun', () => {
    const checklist = parseChecklist(REAL_CHECKLIST)
    const selected = selectConcerns(CTX_BUN_NEON_MONOREPO, checklist)
    const script = composeScript(selected, 'setup')
    const result = execSync('shellcheck -S warning -', {
      input: script,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // shellcheck emits nothing to stdout when the script is clean
    expect(result).toBe('')
  })
})
