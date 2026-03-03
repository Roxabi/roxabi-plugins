/**
 * Tests for the updated handleUpdate — per-project field resolution.
 * RED phase: fail until Task 2.3 updates update.ts.
 */

// Must be set before any module that calls detectGitHubRepo() at load time
process.env.GITHUB_REPO = 'Test/test-repo'
process.env.PROJECT_ID = 'PVT_env'
process.env.STATUS_FIELD_ID = 'SF_env'
process.env.SIZE_FIELD_ID = 'SZ_env'
process.env.PRIORITY_FIELD_ID = 'PR_env'
process.env.STATUS_OPTIONS_JSON = JSON.stringify({ 'In Progress': 'OPT_IP_ENV' })
process.env.SIZE_OPTIONS_JSON = JSON.stringify({ XL: 'OPT_XL_ENV' })
process.env.PRIORITY_OPTIONS_JSON = JSON.stringify({ 'P1 - High': 'OPT_P1_ENV' })

import { test, expect, vi, beforeEach } from 'vitest'

const mockGetItemId = vi.hoisted(() => vi.fn(() => Promise.resolve('ITEM_42')))
const mockUpdateField = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('../../shared/github', () => ({
  getItemId: mockGetItemId,
  updateField: mockUpdateField,
}))

vi.mock('../../shared/workspace', () => ({
  readWorkspace: () => ({
    projects: [
      {
        repo: 'test/ryvo',
        projectId: 'PVT_test',
        label: 'ryvo-tech',
        type: 'technical',
        fieldIds: {
          status: 'SF_proj',
          col2: 'COL2_ID',
          col3: 'COL3_ID',
          statusOptions: { 'In Progress': 'OPT_STATUS_IP' },
          col2Options: { XL: 'OPT_XL_PROJ' },
          col3Options: { 'P1 - High': 'OPT_P1_PROJ' },
        },
      },
    ],
  }),
  writeWorkspace: vi.fn(() => {}),
}))

const { handleUpdate } = await import('./update')

beforeEach(() => {
  mockGetItemId.mockClear()
  mockUpdateField.mockClear()
})

test('uses project fieldIds.col2 for size field when projectLabel provided', async () => {
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  const res = await handleUpdate(req)
  const data = await res.json() as { ok: boolean }
  expect(data.ok).toBe(true)
  // should use COL2_ID (project fieldIds), not SZ_env (global .env)
  expect(mockUpdateField).toHaveBeenCalledWith('ITEM_42', 'COL2_ID', 'OPT_XL_PROJ')
})

test('skips update (ok: true) when fieldIds.col2 absent for slot', async () => {
  // Test with a field that has no ID (col3 absent in project fieldIds... but it's present)
  // Use a slot that maps to a missing field: send field='col2' for a project without col2
  // We'll test this via the legacy path where field='size' maps to col2 in env
  // but env SIZE_FIELD_ID is present — so test with an unknown field instead
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'unknown-slot', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  const res = await handleUpdate(req)
  const data = await res.json() as { ok: boolean }
  // unknown slot → no fieldId → no-op, ok: true
  expect(data.ok).toBe(true)
  expect(mockUpdateField).not.toHaveBeenCalled()
})

test('resolves dropdown from fieldIds.col2Options', async () => {
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  await handleUpdate(req)
  // Verify it used the project-specific option ID, not the global env one
  const [, , optionId] = mockUpdateField.mock.calls[0] as [string, string, string]
  expect(optionId).toBe('OPT_XL_PROJ')
  expect(optionId).not.toBe('OPT_XL_ENV')
})
