import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findTestFiles, forksAProcess, INTEGRATION_SUFFIX } from '../forking-tests'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ─── forksAProcess ───────────────────────────────────────────────────────────

describe('forksAProcess', () => {
  it('flags a file that imports child_process', () => {
    expect(forksAProcess("import { execSync } from 'node:child_process'\nexecSync('git status')")).toBe(true)
  })

  it('flags a direct Bun.spawnSync call', () => {
    expect(forksAProcess("const r = Bun.spawnSync(['git', 'status'])")).toBe(true)
  })

  it('does not flag a comment that merely mentions a spawn API', () => {
    // adapters.test.ts carried exactly this line and no executable spawn.
    expect(forksAProcess('// TODO: Add behavioral tests with mocked Bun.spawnSync and fetch')).toBe(false)
  })

  it('does not flag a spawn API named inside a block comment', () => {
    expect(
      forksAProcess("/*\n * Callers reach execSync from 'node:child_process' here.\n */\nexport const x = 1"),
    ).toBe(false)
  })

  it('does not flag a file that mocks child_process away', () => {
    const source = ["import { execSync } from 'node:child_process'", "vi.mock('node:child_process')"].join('\n')
    expect(forksAProcess(source)).toBe(false)
  })

  it('still flags Bun.spawnSync when child_process is mocked — the mock cannot reach a global', () => {
    const source = ["vi.mock('node:child_process')", "Bun.spawnSync(['git', 'status'])"].join('\n')
    expect(forksAProcess(source)).toBe(true)
  })

  it('does not mistake a protocol-relative URL for a line comment', () => {
    expect(forksAProcess("const url = 'https://example.com' // see child_process docs")).toBe(false)
  })

  it('does not flag an import quoted inside a fixture string — data, not code', () => {
    // This very file is scanned by the convention test below. Without telling
    // code position from data, the predicate would denounce its own fixtures.
    const fixture = String.raw`expect(run("import { execSync } from 'node:child_process'")).toBe(true)`
    expect(forksAProcess(fixture)).toBe(false)
  })

  it('survives a regex literal holding an unbalanced quote', () => {
    const source = ['const QUOTE = /[\'"]/', "import { execSync } from 'node:child_process'"].join('\n')
    expect(forksAProcess(source)).toBe(true)
  })
})

// ─── the repo-wide convention ────────────────────────────────────────────────

describe('integration test naming', () => {
  it('finds the suite', () => {
    // Guards the walker itself: a broken walk would make the invariant below
    // pass vacuously over an empty set.
    expect(findTestFiles(ROOT).length).toBeGreaterThan(50)
  })

  it('every test that forks a process is named for the integration project', () => {
    const misnamed = findTestFiles(ROOT).filter(
      (file) => !file.includes(INTEGRATION_SUFFIX) && forksAProcess(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    )
    expect(
      misnamed,
      `These tests fork a process but run on the 5s unit budget, so they flake under CI load (#502).\n` +
        `Rename each to *${INTEGRATION_SUFFIX}<ext>:\n  ${misnamed.join('\n  ')}`,
    ).toEqual([])
  })
})
