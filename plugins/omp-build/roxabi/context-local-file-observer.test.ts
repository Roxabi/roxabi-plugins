import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createContextLocalFileObserver } from './context-local-file-observer.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'context-local-file-observer-'))
  roots.push(dir)
  return dir
}

function namespace(id = 'observer-1') {
  return {
    kind: 'confirmation-local-observer' as const,
    id,
    sessionId: 'session-1',
    agentId: 'agent-1',
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function resource(
  absolutePath: string,
  expected: { kind: 'absent' } | { kind: 'regular-file'; sha256: string; bytes: number; mode: number },
  key = 'outside-file',
) {
  return { key, absolutePath, basis: 'accept-named-state' as const, expected }
}

function writeRegular(path: string, body: Buffer | string, mode = 0o644): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  writeFileSync(path, bytes)
  chmodSync(path, mode)
  return bytes
}

async function observeOnce(resources: ReturnType<typeof resource>[], current: () => boolean = () => true) {
  const observer = createContextLocalFileObserver(namespace(), current)
  try {
    return await observer.observe(resources)
  } finally {
    await observer.dispose()
  }
}

describe('createContextLocalFileObserver', () => {
  it('samples absent and present named regular files under a live owner', async () => {
    const dir = root()
    const absentPath = join(dir, 'missing.txt')
    const presentPath = join(dir, 'present.txt')
    const body = writeRegular(presentPath, 'outside-effect-payload\n')
    const observer = createContextLocalFileObserver(namespace(), () => true)
    try {
      const sampled = await observer.observe([
        resource(absentPath, { kind: 'absent' }, 'absent'),
        resource(
          presentPath,
          { kind: 'regular-file', sha256: sha256(body), bytes: body.length, mode: 0o644 },
          'present',
        ),
      ])
      expect(sampled.ok).toBe(true)
      if (!sampled.ok) throw new Error('sample-failed')
      expect(sampled.value).toEqual([
        expect.objectContaining({
          key: 'absent',
          absolutePath: absentPath,
          state: { kind: 'absent' },
          file: null,
        }),
        expect.objectContaining({
          key: 'present',
          absolutePath: presentPath,
          state: expect.objectContaining({
            kind: 'regular-file',
            sha256: sha256(body),
            bytes: body.length,
          }),
          file: expect.objectContaining({
            identity: expect.objectContaining({ device: expect.any(String), inode: expect.any(String) }),
          }),
        }),
      ])
    } finally {
      await observer.dispose()
    }
  })

  it('admits an empty resource list when ownership remains live', async () => {
    const observer = createContextLocalFileObserver(namespace(), () => true)
    try {
      await expect(observer.observe([])).resolves.toEqual({ ok: true, value: [] })
    } finally {
      await observer.dispose()
    }
  })

  it('refuses empty resources when ownership is inactive', async () => {
    const sampled = await observeOnce([], () => false)
    expect(sampled.ok).toBe(false)
  })

  it('refuses expected mismatches for size, mode, hash, presence, and absence', async () => {
    const dir = root()
    const path = join(dir, 'named.txt')
    const body = writeRegular(path, 'named-body\n')
    const cases = [
      resource(path, { kind: 'regular-file', sha256: sha256(body), bytes: body.length + 1, mode: 0o644 }),
      resource(path, { kind: 'regular-file', sha256: sha256(body), bytes: body.length, mode: 0o600 }),
      resource(path, { kind: 'regular-file', sha256: 'a'.repeat(64), bytes: body.length, mode: 0o644 }),
      resource(path, { kind: 'absent' }),
      resource(join(dir, 'gone.txt'), {
        kind: 'regular-file',
        sha256: sha256(body),
        bytes: body.length,
        mode: 0o644,
      }),
    ]
    for (const item of cases) {
      const sampled = await observeOnce([item])
      expect(sampled.ok).toBe(false)
    }
  })

  it('refuses symlink leaf, non-regular leaf, and missing parent', async () => {
    const dir = root()
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'target\n')
    const link = join(dir, 'link.txt')
    symlinkSync(target, link)
    const directoryLeaf = join(dir, 'subdir')
    mkdirSync(directoryLeaf)
    for (const item of [
      resource(link, { kind: 'regular-file', sha256: sha256('target\n'), bytes: 7, mode: 0o644 }),
      resource(directoryLeaf, { kind: 'regular-file', sha256: sha256('x'), bytes: 1, mode: 0o755 }),
      resource(join(dir, 'missing-parent', 'leaf.txt'), { kind: 'absent' }),
    ]) {
      const sampled = await observeOnce([item])
      expect(sampled.ok).toBe(false)
    }
  })

  it('detects content drift and identity replacement across successive samples', async () => {
    const dir = root()
    const path = join(dir, 'mutable.txt')
    const first = writeRegular(path, 'first\n')
    const contentObserver = createContextLocalFileObserver(namespace('content'), () => true)
    try {
      const baseline = await contentObserver.observe([
        resource(path, { kind: 'regular-file', sha256: sha256(first), bytes: first.length, mode: 0o644 }),
      ])
      expect(baseline.ok).toBe(true)
      writeRegular(path, 'second\n')
      const drifted = await contentObserver.observe([
        resource(path, { kind: 'regular-file', sha256: sha256('second\n'), bytes: 7, mode: 0o644 }),
      ])
      expect(drifted.ok).toBe(false)
    } finally {
      await contentObserver.dispose()
    }

    const replaced = join(dir, 'replaced.txt')
    writeRegular(replaced, first)
    const identityObserver = createContextLocalFileObserver(namespace('identity'), () => true)
    try {
      const firstSample = await identityObserver.observe([
        resource(replaced, { kind: 'regular-file', sha256: sha256(first), bytes: first.length, mode: 0o644 }),
      ])
      expect(firstSample.ok).toBe(true)
      // Keep the original inode alive under a sibling path so replacement cannot ABA-reuse it.
      renameSync(replaced, join(dir, 'replaced-retained.txt'))
      writeRegular(replaced, first)
      const identityDrift = await identityObserver.observe([
        resource(replaced, { kind: 'regular-file', sha256: sha256(first), bytes: first.length, mode: 0o644 }),
      ])
      expect(identityDrift.ok).toBe(false)
    } finally {
      await identityObserver.dispose()
    }
  })

  it('invalidates the observer after a failed observation and refuses revival', async () => {
    const dir = root()
    const path = join(dir, 'owned.txt')
    writeRegular(path, 'owned\n')
    let live = true
    const observer = createContextLocalFileObserver(namespace(), () => live)
    live = false
    const inactive = await observer.observe([resource(path, { kind: 'absent' })])
    expect(inactive.ok).toBe(false)
    live = true
    const revived = await observer.observe([resource(path, { kind: 'absent' })])
    expect(revived.ok).toBe(false)
    await observer.dispose()
  })

  it('rejects noncanonical and foreign path shapes without rewriting', async () => {
    for (const item of [
      resource('/tmp/../outside.txt', { kind: 'absent' }),
      resource('relative.txt', { kind: 'absent' }),
      resource('file:///tmp/x', { kind: 'absent' }),
    ]) {
      const sampled = await observeOnce([item])
      expect(sampled.ok).toBe(false)
    }
  })

  it('refuses present sampling after an absent baseline for the same path', async () => {
    const dir = root()
    const path = join(dir, 'later.txt')
    const observer = createContextLocalFileObserver(namespace(), () => true)
    try {
      const absent = await observer.observe([resource(path, { kind: 'absent' })])
      expect(absent.ok).toBe(true)
      if (!absent.ok) throw new Error('absent-failed')
      expect(absent.value[0]).toEqual(expect.objectContaining({ state: { kind: 'absent' }, file: null }))
      const body = writeRegular(path, 'now-present\n')
      const drifted = await observer.observe([
        resource(path, { kind: 'regular-file', sha256: sha256(body), bytes: body.length, mode: 0o644 }),
      ])
      expect(drifted.ok).toBe(false)
    } finally {
      await observer.dispose()
    }
  })
})
