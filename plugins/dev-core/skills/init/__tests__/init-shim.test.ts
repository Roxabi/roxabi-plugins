import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDevInitEntry } from '../init'

describe('resolveDevInitEntry', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'init-shim-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeEntry(dir: string) {
    const entry = join(dir, 'skills', 'init', 'init.ts')
    mkdirSync(join(dir, 'skills', 'init'), { recursive: true })
    writeFileSync(entry, '// stub\n')
    return entry
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

  it('skips orphaned version dirs', () => {
    const cacheRoot = join(tmp, 'cache', 'roxabi-marketplace')
    const orphaned = join(cacheRoot, 'dev-init', 'old')
    writeEntry(orphaned)
    writeFileSync(join(orphaned, '.orphaned_at'), '1')
    const good = join(cacheRoot, 'dev-init', 'new')
    const entry = writeEntry(good)
    const root = join(cacheRoot, 'dev-core', '0.8.16')
    mkdirSync(root, { recursive: true })

    expect(resolveDevInitEntry(root)).toBe(entry)
  })
})
