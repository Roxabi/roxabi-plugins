import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  insertLefthookPrincipalFreeze,
  inspectPrincipalFreeze,
  lefthookHasPrincipalFreeze,
  lefthookSectionBindsPrincipalFreeze,
  resolvePrincipalFreezeSourceDir,
  seedPrincipalFreeze,
} from '../lib/seed-principal-freeze'

const monorepoScripts = join(import.meta.dirname, '..', '..', '..', '..', 'dev-core', 'scripts')

const bothHooks = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
    lint:
      run: bun run lint

pre-push:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`

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

describe('lefthookHasPrincipalFreeze', () => {
  it('requires a real run: under both pre-commit and pre-push', () => {
    expect(lefthookHasPrincipalFreeze(bothHooks)).toBe(true)
  })

  it('rejects a comment-only mention', () => {
    const src = `pre-commit:
  commands:
    lint:
      run: bun run lint
    # later: bash scripts/check-principal-branch.sh

pre-push:
  commands:
    test:
      run: bun run test
`
    expect(lefthookHasPrincipalFreeze(src)).toBe(false)
  })

  it('rejects a single-section bind', () => {
    const src = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(src)).toBe(false)
    expect(lefthookSectionBindsPrincipalFreeze(src, 'pre-commit')).toBe(true)
    expect(lefthookSectionBindsPrincipalFreeze(src, 'pre-push')).toBe(false)
  })

  it('accepts this-repo lefthook path under plugins/dev-core/scripts', () => {
    const src = `pre-commit:
  commands:
    principal-freeze:
      run: bash plugins/dev-core/scripts/check-principal-branch.sh

pre-push:
  commands:
    principal-freeze:
      run: bash plugins/dev-core/scripts/check-principal-branch.sh
`
    expect(lefthookHasPrincipalFreeze(src)).toBe(true)
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
    expect((yaml.match(/check-principal-branch\.sh/g) ?? []).length).toBe(2)
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(true)
  })

  it('patches the missing hook when only pre-commit is bound', () => {
    const src = `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
    lint:
      run: bun run lint
`
    const { yaml, changed } = insertLefthookPrincipalFreeze(src)
    expect(changed).toBe(true)
    expect(lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')).toBe(true)
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(true)
  })

  it('is idempotent when both hooks bind', () => {
    const { changed } = insertLefthookPrincipalFreeze(bothHooks)
    expect(changed).toBe(false)
  })

  it('still inserts when only a comment mentions the script', () => {
    const src = `pre-commit:
  commands:
    lint:
      run: bun run lint
    # bash scripts/check-principal-branch.sh

pre-push:
  commands:
    test:
      run: bun run test
`
    const { yaml, changed } = insertLefthookPrincipalFreeze(src)
    expect(changed).toBe(true)
    expect(lefthookHasPrincipalFreeze(yaml)).toBe(true)
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
    expect(r.persist).toBe(true)
    expect(r.lefthookPreCommit).toBe(true)
    expect(r.lefthookPrePush).toBe(true)
    const y = readFileSync(join(tmp, 'lefthook.yml'), 'utf8')
    expect(lefthookHasPrincipalFreeze(y)).toBe(true)
  })

  it('replaces a stub script and patches the missing hook', () => {
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
    expect(r.written.some((p) => p.endsWith('check-principal-branch.sh'))).toBe(true)
    expect(r.patched).toEqual([join(tmp, 'lefthook.yml')])
    expect(r.persist).toBe(true)
    const dest = readFileSync(join(tmp, 'scripts/check-principal-branch.sh'))
    const src = readFileSync(join(monorepoScripts, 'check-principal-branch.sh'))
    expect(dest.equals(src)).toBe(true)
  })

  it('skips a canonical script and does not re-patch a complete lefthook.yml', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-pf-'))
    mkdirSync(join(tmp, 'scripts'))
    writeFileSync(
      join(tmp, 'scripts/check-principal-branch.sh'),
      readFileSync(join(monorepoScripts, 'check-principal-branch.sh')),
    )
    writeFileSync(join(tmp, 'lefthook.yml'), bothHooks)
    const r = seedPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.written).toEqual([])
    expect(r.skipped.length).toBe(1)
    expect(r.patched).toEqual([])
    expect(r.persist).toBe(true)
  })

  it('errors when source missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seed-pf-'))
    const r = seedPrincipalFreeze({ cwd: tmp, sourceDir: join(tmp, 'nope') })
    expect(r.error).toBeTruthy()
  })
})

describe('inspectPrincipalFreeze', () => {
  let tmp: string

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('persist is false when both hooks bind but the script is missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'inspect-pf-'))
    writeFileSync(join(tmp, 'lefthook.yml'), bothHooks)
    const r = inspectPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.scriptExists).toBe(false)
    expect(r.lefthookPreCommit).toBe(true)
    expect(r.lefthookPrePush).toBe(true)
    expect(r.persist).toBe(false)
  })

  it('persist is false when the script is canonical but only one hook binds', () => {
    tmp = mkdtempSync(join(tmpdir(), 'inspect-pf-'))
    mkdirSync(join(tmp, 'scripts'))
    writeFileSync(
      join(tmp, 'scripts/check-principal-branch.sh'),
      readFileSync(join(monorepoScripts, 'check-principal-branch.sh')),
    )
    writeFileSync(
      join(tmp, 'lefthook.yml'),
      `pre-commit:
  commands:
    principal-freeze:
      run: bash scripts/check-principal-branch.sh
`,
    )
    const r = inspectPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.scriptCanonical).toBe(true)
    expect(r.lefthookPreCommit).toBe(true)
    expect(r.lefthookPrePush).toBe(false)
    expect(r.persist).toBe(false)
  })

  it('persist is true when the script is canonical and both hooks bind', () => {
    tmp = mkdtempSync(join(tmpdir(), 'inspect-pf-'))
    mkdirSync(join(tmp, 'scripts'))
    writeFileSync(
      join(tmp, 'scripts/check-principal-branch.sh'),
      readFileSync(join(monorepoScripts, 'check-principal-branch.sh')),
    )
    writeFileSync(join(tmp, 'lefthook.yml'), bothHooks)
    const r = inspectPrincipalFreeze({ cwd: tmp, sourceDir: monorepoScripts })
    expect(r.scriptCanonical).toBe(true)
    expect(r.lefthookPreCommit).toBe(true)
    expect(r.lefthookPrePush).toBe(true)
    expect(r.persist).toBe(true)
  })
})
