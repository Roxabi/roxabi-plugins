import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ActionSnapshot } from './uw-action-contract.ts'
import { type ActionSnapshotClaim, sealActionSnapshot } from './uw-action-snapshot.ts'
import { createActionSnapshotStore } from './uw-action-snapshot-store.ts'

function claimFor(indexPath: string, location: ActionSnapshot['location']): ActionSnapshotClaim {
  return {
    id: indexPath,
    actionId: 'review-1',
    manifestDigest: 'a'.repeat(64),
    indexPath,
    location,
  }
}

describe('action snapshot seal', () => {
  test.each(['extra file', 'empty directory', 'mismatched bytes', 'missing file', 'symlink'] as const)(
    'refuses sealing a snapshot with %s',
    async (mismatch) => {
      const root = mkdtempSync(join(tmpdir(), 'omp-action-'))
      try {
        const bytes = Buffer.from('# sealed\n')
        const files = [{ path: 'index.md', bytes }]
        const store = createActionSnapshotStore({ artifactsDir: root, cwd: root })
        const placed = await store.create({ actionId: 'review-1', files })
        if (!placed.ok) throw new Error('placement failed')
        const { indexPath, location } = placed.value
        const directory = dirname(indexPath)
        if (mismatch === 'extra file') writeFileSync(join(directory, 'extra.txt'), 'extra\n')
        if (mismatch === 'empty directory') mkdirSync(join(directory, 'empty'))
        if (mismatch === 'mismatched bytes') {
          chmodSync(indexPath, 0o644)
          writeFileSync(indexPath, 'tampered\n')
        }
        if (mismatch === 'missing file' || mismatch === 'symlink') unlinkSync(indexPath)
        if (mismatch === 'symlink') symlinkSync('index.md', indexPath)
        expect(sealActionSnapshot(claimFor(indexPath, location), files)).toMatchObject({
          ok: false,
          diagnostics: [{ code: 'snapshot-mutated' }],
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test('publishes the intended tree hash including a directory entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-action-'))
    try {
      const files = [{ path: 'plugin/glossary.md', bytes: new Uint8Array(Buffer.from('term\n')) }]
      const store = createActionSnapshotStore({ artifactsDir: root, cwd: root })
      const placed = await store.create({ actionId: 'review-1', files })
      if (!placed.ok) throw new Error('placement failed')
      const sealed = sealActionSnapshot(claimFor(placed.value.indexPath, placed.value.location), files)
      expect(sealed.ok).toBe(true)
      if (!sealed.ok) return
      expect(sealed.value.integrityDigest).toBe('e18c828552bbfd51ff0fc7b1387d2201df3af2aec3fc918e217d3dadbe532f76')
      expect(Object.isFrozen(sealed.value)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses a symlink snapshot root and seals an empty directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-action-'))
    try {
      const real = join(root, 'real')
      mkdirSync(real)
      const link = join(root, 'link')
      symlinkSync(real, link)
      const linked = sealActionSnapshot(claimFor(join(link, 'index.md'), 'local'), [])
      expect(linked.ok).toBe(false)
      const empty = join(root, 'empty')
      mkdirSync(empty)
      const sealed = sealActionSnapshot(claimFor(join(empty, 'index.md'), 'local'), [])
      expect(sealed.ok).toBe(true)
      if (!sealed.ok) return
      expect(sealed.value.integrityDigest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
