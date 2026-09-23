/**
 * `adr.ts axial`, executed.
 *
 * The exit code is what `/R-dev-init` Phase 3a and the axial interview branch
 * on, so it is the contract: two axial ADRs is the corpus contradiction and
 * exits 1; zero is a repo that has not run `/R-adr --axial` yet, which is a
 * state to report, not a failure to raise.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', 'adr.ts')

let dir: string

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'adr-cli-')), 'adr')
  mkdirSync(dir, { recursive: true })
})

afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

function adr(nnn: string, extra = ''): void {
  writeFileSync(
    join(dir, `${nnn}-a.md`),
    `---\ntitle: "ADR-${nnn}: A"\nstatus: accepted\nnormative: true\ndate: 2026-01-01${extra}\n---\n\n## Context\n\nwhy.\n`,
  )
}

function axialCli(): { code: number; json: Record<string, unknown> } {
  const result = spawnSync('bun', [CLI, 'axial', '--dir', dir], { encoding: 'utf-8' })
  return { code: result.status ?? -1, json: JSON.parse(result.stdout) }
}

describe('adr.ts axial', () => {
  it('exits 0 and reports declared: false when no axis is declared', () => {
    adr('001')

    const { code, json } = axialCli()
    expect(code).toBe(0)
    expect(json).toMatchObject({ count: 0, declared: false, singleton: false, violated: false })
  })

  it('exits 0 when exactly one ADR is axial', () => {
    adr('001', '\naxial: true')

    const { code, json } = axialCli()
    expect(code).toBe(0)
    expect(json).toMatchObject({ count: 1, declared: true, singleton: true, violated: false })
  })

  it('exits 1 when two ADRs are axial', () => {
    adr('001', '\naxial: true')
    adr('002', '\naxial: true')

    const { code, json } = axialCli()
    expect(code).toBe(1)
    expect(json).toMatchObject({ count: 2, violated: true })
  })
})
