/**
 * Tests for resolveFieldIds / fieldIdForSlot added to config.ts.
 * Runs in the same worker as config.test.ts — env is already set up:
 *   GITHUB_REPO = 'Test/test-repo', STATUS_OPTIONS_JSON cleared.
 */

import { describe, expect, it } from 'vitest'

// Re-use the already-imported config module (same module cache as config.test.ts)
const { resolveFieldIds, fieldIdForSlot } = await import('../config')

describe('resolveFieldIds', () => {
  it('uses project.fieldIds when present', () => {
    const project = {
      repo: 'r', projectId: 'p', label: 'l',
      fieldIds: { status: 'S1', col2: 'C1', col3: 'C2' },
    }
    const ids = resolveFieldIds(project)
    expect(ids.status).toBe('S1')
    expect(ids.col2).toBe('C1')
    expect(ids.col3).toBe('C2')
  })

  it('falls back to .env values when fieldIds absent', () => {
    const project = { repo: 'r', projectId: 'p', label: 'l' }
    const ids = resolveFieldIds(project)
    // Falls back to process.env.STATUS_FIELD_ID ('' in test env)
    expect(typeof ids.status).toBe('string')
    expect(typeof ids.col2).toBe('string')
    expect(typeof ids.col3).toBe('string')
    // Options come from cleared env vars — must be Record<string, string>
    expect(typeof ids.statusOptions).toBe('object')
    expect(typeof ids.col2Options).toBe('object')
    expect(typeof ids.col3Options).toBe('object')
  })

  it('throws when fieldIds present but status missing', () => {
    const project = {
      repo: 'r', projectId: 'p', label: 'test-proj',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldIds: { col2: 'C1', col3: 'C2' } as any,
    }
    expect(() => resolveFieldIds(project)).toThrow('fieldIds.status is required')
  })
})

describe('fieldIdForSlot', () => {
  it('returns col2 field id', () => {
    const project = {
      repo: 'r', projectId: 'p', label: 'l',
      fieldIds: { status: 'S1', col2: 'C2', col3: 'C3' },
    }
    expect(fieldIdForSlot(project, 'col2')).toBe('C2')
  })

  it('returns col3 field id', () => {
    const project = {
      repo: 'r', projectId: 'p', label: 'l',
      fieldIds: { status: 'S1', col2: 'C2', col3: 'C3' },
    }
    expect(fieldIdForSlot(project, 'col3')).toBe('C3')
  })

  it('returns undefined when slot absent in fieldIds', () => {
    const project = {
      repo: 'r', projectId: 'p', label: 'l',
      fieldIds: { status: 'S1' },
    }
    expect(fieldIdForSlot(project, 'col2')).toBeUndefined()
  })
})
