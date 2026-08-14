import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  insertLefthookPrincipalFreeze,
  lefthookHasPrincipalFreeze,
  resolvePrincipalFreezeSourceDir,
  seedPrincipalFreeze,
} from '../lib/seed-principal-freeze'

const monorepoScripts = join(import.meta.dirname, '..', '..', '..', '..', 'dev-core', 'scripts')

describe('resolvePrincipalFreezeSourceDir', () => {
  it('finds monorepo scripts via explicit path', () => {
    const dir = resolvePrincipalFreezeSourceDir(monorepoScripts)
    expect(dir).toBe(monorepoScripts)
    expect(existsSync(join(monorepoScripts, 'check-principal-branch.sh'))).toBe(true)
  })

  it('returns null for explicit missing path', () => {
    expect(resolvePrincipalFreezeSourceDir(join(tmpdir(), 'nope-pf-src'))).toBeNull()
  })

  it('finds monorepo scripts without args', () => {
    const dir = resolvePrincipalFreezeSourceDir()
    expect(dir).toBeTruthy()
    expect(existsSync(join(dir as string, 'check-principal-branch.sh'))).toBe(true)
  })
})

describe('insertLefthookPrincipalFreeze', () => {
  it('inserts under pre-commit and pre-push commands', () => {
    const src = `pre-commit:
  commands:
    lint:
      run: bun run lint

pre-push:
  commands:
    test:
      run: bun run test
`
    const { yaml, changed } = insertLefthookPrincipalFreeze(src)
    expect(changed).toBe(true)
    expect(yaml).toContain('principal-freeze:')
    expect((yaml.match(/check-principal-branch\.sh/g) ?? []).length).toBe(2)
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(true)
  })

  it('is idempotent', () => {
    const src = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
    lint:
      run: bun run lint
`
    const { changed } = insertLefthookPrincipalFreeze(src)
    expect(changed).toBe(false)
  })
})

describe('seedPrincipalFreeze', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('writes the script and patches lefthook.yml', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-pf-'))
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:
  commands:
    lint:
      run: bun run lint

pre-push:
  commands:
    test:
      run: bun run test
`,
    )
    const r = seedPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.error).toBeUndefined()
    expect(r.written.some((p) => p.endsWith('check-principal-branch.sh'))).toBe(true)
    expect(existsSync(join(tmp, 'scripts/check-principal-branch.sh'))).toBe(true)
    expect(r.patched).toEqual([join(tmp, 'lefthook.yml')])
    const y = readFileSync(join(tmp, 'lefthook.yml'), 'utf8')
    expect(y).toContain('bash scripts/check-principal-branch.sh')
  })

  it('skips existing script without --force and does not re-patch', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-pf-'))
    mkdirSync(join(tmp, 'scripts'))
    writeFileSync(join(tmp, 'scripts/check-principal-branch.sh'), '#!/bin/sh\n')
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`,
    )
    const r = seedPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.written).toEqual([])
    expect(r.skipped.length).toBe(1)
    expect(r.patched).toEqual([])
  })

  it('errors when source missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-pf-'))
    const r = seedPrincipalFreeze({ cwd: tmp, sourceDir: join(tmp, 'nope') })
    expect(r.error).toBeTruthy()
  })
})
