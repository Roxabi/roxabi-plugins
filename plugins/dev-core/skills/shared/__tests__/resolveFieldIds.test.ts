/**
 * Tests for resolveFieldIds / fieldIdForSlot added to config.ts.
 * Runs in the same worker as config.test.ts — env is already set up:
 *   GITHUB_REPO = 'Test/test-repo', STATUS_OPTIONS_JSON cleared.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectFieldIds } from '../workspace'

// Re-use the already-imported config module (same module cache as config.test.ts)
const {
  resolveFieldIds,
  fieldIdForSlot,
  STATUS_FIELD_ID,
  SIZE_FIELD_ID,
  PRIORITY_FIELD_ID,
  STATUS_OPTIONS,
  SIZE_OPTIONS,
  PRIORITY_OPTIONS,
} = await import('../config')

describe('resolveFieldIds', () => {
  it('uses project.fieldIds when present', () => {
    const project = {
      repo: 'r',
      projectId: 'p',
      label: 'l',
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
    // Falls back to module-level constants loaded from .env
    expect(ids.status).toBe(STATUS_FIELD_ID)
    expect(ids.col2).toBe(SIZE_FIELD_ID)
    expect(ids.col3).toBe(PRIORITY_FIELD_ID)
    expect(ids.statusOptions).toEqual(STATUS_OPTIONS)
    expect(ids.col2Options).toEqual(SIZE_OPTIONS)
    expect(ids.col3Options).toEqual(PRIORITY_OPTIONS)
  })

  it('throws when fieldIds present but status missing', () => {
    const project = {
      repo: 'r',
      projectId: 'p',
      label: 'test-proj',
      // `as any` — tests the JSON-deserialization path: workspace.json written by hand
      // or a future version may contain fieldIds without status; TypeScript won't catch it at runtime.
      fieldIds: { col2: 'C1', col3: 'C2' } as unknown as ProjectFieldIds,
    }
    expect(() => resolveFieldIds(project)).toThrow('[project test-proj] fieldIds.status is required')
  })

  it('falls back to .env when fieldIds is {} (empty object)', () => {
    const project = { repo: 'r', projectId: 'p', label: 'empty-proj', fieldIds: {} as ProjectFieldIds }
    // Empty fieldIds ({}) is written by /init when GitHub field resolution fails.
    // It must fall through to the .env fallback — not throw.
    const ids = resolveFieldIds(project)
    expect(ids.status).toBe(STATUS_FIELD_ID)
    expect(ids.col2).toBe(SIZE_FIELD_ID)
    expect(ids.col3).toBe(PRIORITY_FIELD_ID)
    expect(ids.statusOptions).toEqual(STATUS_OPTIONS)
    expect(ids.col2Options).toEqual(SIZE_OPTIONS)
    expect(ids.col3Options).toEqual(PRIORITY_OPTIONS)
  })
})

describe('fieldIdForSlot', () => {
  it('returns col2 field id', () => {
    const project = {
      repo: 'r',
      projectId: 'p',
      label: 'l',
      fieldIds: { status: 'S1', col2: 'C2', col3: 'C3' },
    }
    expect(fieldIdForSlot(project, 'col2')).toBe('C2')
  })

  it('returns col3 field id', () => {
    const project = {
      repo: 'r',
      projectId: 'p',
      label: 'l',
      fieldIds: { status: 'S1', col2: 'C2', col3: 'C3' },
    }
    expect(fieldIdForSlot(project, 'col3')).toBe('C3')
  })

  it('returns undefined when slot absent in fieldIds', () => {
    const project = {
      repo: 'r',
      projectId: 'p',
      label: 'l',
      fieldIds: { status: 'S1' },
    }
    expect(fieldIdForSlot(project, 'col2')).toBeUndefined()
  })
})
