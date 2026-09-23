import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAdrHygieneSourceDir, seedAdrHygieneScript } from '../lib/seed-adr-hygiene'

const monorepoScripts = join(import.meta.dirname, '..', '..', '..', 'scripts')
const SCRIPT = 'check-agents-adr-hygiene.sh'

let tmp: string | null = null

function project(): string {
  tmp = mkdtempSync(join(tmpdir(), 'seed-adr-hygiene-'))
  return tmp
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('resolveAdrHygieneSourceDir', () => {
  it('finds the script in the monorepo layout', () => {
    expect(resolveAdrHygieneSourceDir()).toBe(monorepoScripts)
  })

  it('treats an explicit source dir as authoritative', () => {
    expect(resolveAdrHygieneSourceDir('/nonexistent')).toBeNull()
  })
})

describe('seedAdrHygieneScript', () => {
  it('writes an executable gate into scripts/', () => {
    const cwd = project()
    const result = seedAdrHygieneScript({ cwd })

    expect(result.error).toBeUndefined()
    expect(result.written).toEqual([join(cwd, 'scripts', SCRIPT)])
    expect(readFileSync(join(cwd, 'scripts', SCRIPT), 'utf-8')).toBe(
      readFileSync(join(monorepoScripts, SCRIPT), 'utf-8'),
    )
    expect(statSync(join(cwd, 'scripts', SCRIPT)).mode & 0o111).not.toBe(0)
  })

  it('never overwrites a modified local copy', () => {
    const cwd = project()
    seedAdrHygieneScript({ cwd })

    const dest = join(cwd, 'scripts', SCRIPT)
    writeFileSync(dest, '#!/usr/bin/env bash\n# locally tuned\nexit 0\n')
    const result = seedAdrHygieneScript({ cwd })

    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([dest])
    expect(readFileSync(dest, 'utf-8')).toContain('locally tuned')
  })

  it('replaces a modified local copy only when forced', () => {
    const cwd = project()
    const dest = join(cwd, 'scripts', SCRIPT)
    mkdirSync(join(cwd, 'scripts'), { recursive: true })
    writeFileSync(dest, '# stale\n')

    const result = seedAdrHygieneScript({ cwd, force: true })

    expect(result.written).toEqual([dest])
    expect(readFileSync(dest, 'utf-8')).toContain('AGENTS_ADR_CONTRACT_MODE')
  })

  it('reports no work when forced over an identical copy', () => {
    const cwd = project()
    seedAdrHygieneScript({ cwd })
    const result = seedAdrHygieneScript({ cwd, force: true })

    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([join(cwd, 'scripts', SCRIPT)])
  })

  it('restores the executable bit on an existing copy', () => {
    const cwd = project()
    seedAdrHygieneScript({ cwd })
    const dest = join(cwd, 'scripts', SCRIPT)
    chmodSync(dest, 0o644)

    seedAdrHygieneScript({ cwd })

    expect(statSync(dest).mode & 0o111).not.toBe(0)
  })

  it('reports a missing source instead of writing a broken gate', () => {
    const cwd = project()
    const result = seedAdrHygieneScript({ cwd, sourceDir: '/nonexistent' })

    expect(result.error).toContain('seed source not found')
    expect(result.written).toEqual([])
  })
})
