import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTrufflehogSourceDir, seedTrufflehogScripts } from '../lib/seed-trufflehog'

const monorepoScripts = join(import.meta.dirname, '..', '..', '..', '..', 'dev-core', 'scripts')

describe('resolveTrufflehogSourceDir', () => {
  it('finds monorepo plugins/dev-core/scripts via explicit path', () => {
    const dir = resolveTrufflehogSourceDir(monorepoScripts)
    expect(dir).toBe(monorepoScripts)
    expect(existsSync(join(monorepoScripts, 'trufflehog-check.sh'))).toBe(true)
  })

  it('returns null for explicit missing path (no fallthrough)', () => {
    expect(resolveTrufflehogSourceDir(join(tmpdir(), 'nope-th-src'))).toBeNull()
  })

  it('finds monorepo scripts without args (import.meta layout)', () => {
    const dir = resolveTrufflehogSourceDir()
    expect(dir).toBeTruthy()
    expect(existsSync(join(dir as string, 'trufflehog-check.sh'))).toBe(true)
  })

  it('scans cache-style dev-core/* when same-hash peer misses', () => {
    const root = mkdtempSync(join(tmpdir(), 'seed-th-cache-'))
    try {
      // .../cache/mkt/dev-init/<hash>/  vs  .../cache/mkt/dev-core/<semver>/scripts
      const initRoot = join(root, 'dev-init', 'abc123hash')
      const coreScripts = join(root, 'dev-core', '0.11.5', 'scripts')
      mkdirSync(initRoot, { recursive: true })
      mkdirSync(coreScripts, { recursive: true })
      writeFileSync(join(coreScripts, 'trufflehog-check.sh'), '#!/bin/sh\n')
      writeFileSync(join(coreScripts, 'trufflehog-exclude-paths.txt'), 'node_modules\n')
      const prev = process.env.CLAUDE_PLUGIN_ROOT
      process.env.CLAUDE_PLUGIN_ROOT = initRoot
      try {
        expect(resolveTrufflehogSourceDir()).toBe(coreScripts)
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
        else process.env.CLAUDE_PLUGIN_ROOT = prev
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('seedTrufflehogScripts', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('writes both scripts into scripts/ when missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-th-'))
    const r = seedTrufflehogScripts({
      cwd: tmp,
      sourceDir: monorepoScripts,
    })
    expect(r.error).toBeUndefined()
    expect(r.written.length).toBe(2)
    expect(existsSync(join(tmp, 'scripts/trufflehog-check.sh'))).toBe(true)
    expect(existsSync(join(tmp, 'scripts/trufflehog-exclude-paths.txt'))).toBe(true)
    const sh = readFileSync(join(tmp, 'scripts/trufflehog-check.sh'), 'utf8')
    expect(sh).toContain('--since-commit')
    expect(sh).toContain('staged')
  })

  it('skips existing files without --force', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-th-'))
    seedTrufflehogScripts({ cwd: tmp, sourceDir: monorepoScripts })
    const r2 = seedTrufflehogScripts({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r2.written).toEqual([])
    expect(r2.skipped.length).toBe(2)
  })

  it('overwrites with --force when content differs', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-th-'))
    seedTrufflehogScripts({ cwd: tmp, sourceDir: monorepoScripts })
    writeFileSync(join(tmp, 'scripts/trufflehog-check.sh'), '# old\n')
    const r = seedTrufflehogScripts({
      cwd: tmp,
      sourceDir: monorepoScripts,
      force: true,
    })
    expect(r.written.some((p) => p.endsWith('trufflehog-check.sh'))).toBe(true)
    const sh = readFileSync(join(tmp, 'scripts/trufflehog-check.sh'), 'utf8')
    expect(sh).toContain('--since-commit')
  })

  it('skips with --force when content is identical', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-th-'))
    seedTrufflehogScripts({ cwd: tmp, sourceDir: monorepoScripts })
    const r = seedTrufflehogScripts({
      cwd: tmp,
      sourceDir: monorepoScripts,
      force: true,
    })
    expect(r.written).toEqual([])
    expect(r.skipped.length).toBe(2)
  })

  it('errors when source missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-th-'))
    const r = seedTrufflehogScripts({
      cwd: tmp,
      sourceDir: join(tmp, 'nope'),
    })
    expect(r.error).toBeTruthy()
  })
})
