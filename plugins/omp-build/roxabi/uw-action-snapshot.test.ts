import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ActionSnapshot } from './uw-action-contract.ts'
import {
  type ActionSnapshotClaim,
  createActionSnapshotStore,
  intendedSnapshotDigest,
  sealActionSnapshot,
  verifyActionSnapshot,
} from './uw-action-snapshot.ts'

function claimFor(indexPath: string, location: ActionSnapshot['location']): ActionSnapshotClaim {
  return {
    id: indexPath,
    actionId: 'review-1',
    manifestDigest: 'a'.repeat(64),
    indexPath,
    location,
  }
}

async function withSealed(
  run: (box: { snapshot: ActionSnapshot; directory: string; bytes: Uint8Array }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'omp-action-'))
  try {
    const bytes = new Uint8Array(Buffer.from('# sealed\n'))
    const store = createActionSnapshotStore({ artifactsDir: root, cwd: root })
    const placed = await store.create({ actionId: 'review-1', files: [{ path: 'index.md', bytes }] })
    if (!placed.ok) throw new Error(placed.diagnostics.map((item) => item.message).join('; '))
    const sealed = sealActionSnapshot(claimFor(placed.value.indexPath, placed.value.location), [
      { path: 'index.md', bytes },
    ])
    if (!sealed.ok) throw new Error(sealed.diagnostics.map((item) => item.message).join('; '))
    await run({ snapshot: sealed.value, directory: dirname(placed.value.indexPath), bytes })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('action snapshot handle', () => {
  test('rejects a field-equal clone of a registered handle', async () => {
    await withSealed(async ({ snapshot }) => {
      const registered = await verifyActionSnapshot(snapshot)
      expect(registered.ok).toBe(true)
      const clone = { ...snapshot }
      const checked = await verifyActionSnapshot(clone)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('action-handle-unregistered')
    })
  })

  test('refuses a same-path file replaced by a symlink', async () => {
    await withSealed(async ({ snapshot, directory }) => {
      const file = join(directory, 'index.md')
      unlinkSync(file)
      symlinkSync('index.md', file)
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('snapshot-mutated')
    })
  })

  test('refuses an added empty directory', async () => {
    await withSealed(async ({ snapshot, directory }) => {
      mkdirSync(join(directory, 'empty'))
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('snapshot-mutated')
    })
  })

  test('refuses a snapshot root replaced by a symlink', async () => {
    await withSealed(async ({ snapshot, directory }) => {
      const aside = `${directory}-held`
      renameSync(directory, aside)
      symlinkSync(aside, directory)
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('snapshot-mutated')
    })
  })

  test('refuses tampered file bytes', async () => {
    await withSealed(async ({ snapshot, directory }) => {
      const file = join(directory, 'index.md')
      chmodSync(file, 0o644)
      try {
        writeFileSync(file, 'tampered\n')
      } finally {
        chmodSync(file, 0o444)
      }
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('snapshot-mutated')
    })
  })

  test('refuses a missing sealed file', async () => {
    await withSealed(async ({ snapshot, directory }) => {
      unlinkSync(join(directory, 'index.md'))
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(false)
      if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('snapshot-mutated')
    })
  })

  test('keeps the sealed baseline after the caller mutates the input bytes', async () => {
    await withSealed(async ({ snapshot, bytes }) => {
      bytes[0] = 0
      expect(() => {
        Object.assign(snapshot, { actionId: 'tampered' })
      }).toThrow()
      const checked = await verifyActionSnapshot(snapshot)
      expect(checked.ok).toBe(true)
    })
  })

  test('refuses unexpected disk entries and mismatched supplied bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-action-'))
    try {
      const bytes = new Uint8Array(Buffer.from('# sealed\n'))
      const store = createActionSnapshotStore({ artifactsDir: root, cwd: root })
      const placed = await store.create({ actionId: 'review-1', files: [{ path: 'index.md', bytes }] })
      if (!placed.ok) throw new Error('placement failed')
      const directory = dirname(placed.value.indexPath)
      writeFileSync(join(directory, 'extra.txt'), 'extra\n')
      const unexpected = sealActionSnapshot(claimFor(placed.value.indexPath, placed.value.location), [
        { path: 'index.md', bytes },
      ])
      expect(unexpected.ok).toBe(false)
      unlinkSync(join(directory, 'extra.txt'))
      const mismatched = sealActionSnapshot(claimFor(placed.value.indexPath, placed.value.location), [
        { path: 'index.md', bytes: new Uint8Array([1]) },
      ])
      expect(mismatched.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
      expect(sealed.value.integrityDigest).toBe(intendedSnapshotDigest(files))
      expect(sealed.value.integrityDigest).not.toBe(intendedSnapshotDigest([]))
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
      expect(sealed.value.integrityDigest).toBe(intendedSnapshotDigest([]))
      writeFileSync(join(empty, 'later.txt'), 'x\n')
      const checked = await verifyActionSnapshot(sealed.value)
      expect(checked.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
