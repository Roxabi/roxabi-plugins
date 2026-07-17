import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDevInitEntry, tryResolveDevInitEntry } from '../init'

describe('resolveDevInitEntry', () => {
  let tmp: string
  let prevHome: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'init-shim-'))
    // Keep the ~/.claude cache fallback out of resolution — the real one exists on dev machines.
    prevHome = process.env.HOME
    process.env.HOME = tmp
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeEntry(dir: string) {
    const entry = join(dir, 'skills', 'init', 'init.ts')
    mkdirSync(join(dir, 'skills', 'init'), { recursive: true })
    writeFileSync(entry, '// stub\n')
    return entry
  }

  function setMtime(dir: string, epochSeconds: number) {
    utimesSync(dir, epochSeconds, epochSeconds)
  }

  it('prefers flat sibling over versioned cache', () => {
    const mp = join(tmp, 'plugins')
    const flat = writeEntry(join(mp, 'dev-init'))
    const cacheInit = join(tmp, 'cache', 'roxabi-marketplace', 'dev-init', 'oldhash')
    writeEntry(cacheInit)
    const root = join(mp, 'dev-core')
    mkdirSync(root, { recursive: true })

    expect(resolveDevInitEntry(root)).toBe(flat)
  })

  it('resolves versioned cache when flat sibling missing', () => {
    const cacheRoot = join(tmp, 'cache', 'roxabi-marketplace')
    const versionDir = join(cacheRoot, 'dev-init', 'abc123')
    const entry = writeEntry(versionDir)
    const root = join(cacheRoot, 'dev-core', '0.8.16')
    mkdirSync(root, { recursive: true })

    expect(resolveDevInitEntry(root)).toBe(entry)
  })

  it('skips orphaned version dirs even when they are the newest', () => {
    const cacheRoot = join(tmp, 'cache', 'roxabi-marketplace')
    const good = join(cacheRoot, 'dev-init', 'good')
    const entry = writeEntry(good)
    const orphaned = join(cacheRoot, 'dev-init', 'orphaned')
    writeEntry(orphaned)
    writeFileSync(join(orphaned, '.orphaned_at'), '1')
    // Orphaned wins on newest-mtime, so only the .orphaned_at guard can exclude it.
    setMtime(good, 1_000)
    setMtime(orphaned, 2_000)
    const root = join(cacheRoot, 'dev-core', '0.8.16')
    mkdirSync(root, { recursive: true })

    expect(resolveDevInitEntry(root)).toBe(entry)
  })

  it('returns null when the only version dir is orphaned', () => {
    const cacheRoot = join(tmp, 'cache', 'roxabi-marketplace')
    const orphaned = join(cacheRoot, 'dev-init', 'orphaned')
    writeEntry(orphaned)
    writeFileSync(join(orphaned, '.orphaned_at'), '1')
    const root = join(cacheRoot, 'dev-core', '0.8.16')
    mkdirSync(root, { recursive: true })

    expect(tryResolveDevInitEntry(root)).toBeNull()
  })
})
