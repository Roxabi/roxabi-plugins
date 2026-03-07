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

import { beforeEach, expect, test, vi } from 'vitest'

const mockGetItemId = vi.fn(() => Promise.resolve('ITEM_42'))
const mockUpdateField = vi.fn(() => Promise.resolve())
const mockReadWorkspace = vi.fn()
const mockIsProjectConfigured = vi.fn(() => false)

// FIELD_MAP for legacy mode tests — must match the shape used by update.ts
const MOCK_FIELD_MAP = {
  status: { fieldId: 'SF_mock', options: { 'In Progress': 'OPT_IP_MOCK' } },
  size: { fieldId: 'SZ_mock', options: { XL: 'OPT_XL_MOCK' } },
  priority: { fieldId: 'PR_mock', options: { 'P1 - High': 'OPT_P1_MOCK' } },
}

vi.mock('../../shared/adapters/config-helpers', () => ({
  FIELD_MAP: MOCK_FIELD_MAP,
  isProjectConfigured: mockIsProjectConfigured,
  NOT_CONFIGURED_MSG: 'GitHub Project V2 is not configured. Run `/init` to auto-detect project board settings.',
  resolveFieldIds: (project: { fieldIds?: Record<string, unknown> }) => project.fieldIds ?? {},
}))

vi.mock('../../shared/adapters/github-adapter', () => ({
  getItemId: mockGetItemId,
  updateField: mockUpdateField,
}))

vi.mock('../../shared/adapters/workspace-helpers', () => ({
  readWorkspace: mockReadWorkspace,
  writeWorkspace: vi.fn(() => {}),
}))

const defaultProject = {
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
}

const { handleUpdate } = await import('./update')

beforeEach(() => {
  mockGetItemId.mockClear()
  mockUpdateField.mockClear()
  mockReadWorkspace.mockClear()
  mockIsProjectConfigured.mockClear()
  mockIsProjectConfigured.mockReturnValue(false)
  mockReadWorkspace.mockReturnValue({ projects: [defaultProject] })
})

test('uses project fieldIds.col2 for size field when projectLabel provided', async () => {
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean }
  expect(data.ok).toBe(true)
  // should use COL2_ID (project fieldIds), not SZ_env (global .env)
  expect(mockUpdateField).toHaveBeenCalledWith('ITEM_42', 'COL2_ID', 'OPT_XL_PROJ', 'PVT_test')
  // option ID must come from project fieldIds, not global env
  const [, , optionId] = mockUpdateField.mock.calls[0] as unknown as [string, string, string, string]
  expect(optionId).not.toBe('OPT_XL_ENV')
})

test('skips update (ok: true) when col2 absent from project fieldIds', async () => {
  // Project has fieldIds but col2 is absent — update.ts must no-op rather than throw
  mockReadWorkspace.mockReturnValueOnce({
    projects: [{ ...defaultProject, fieldIds: { status: 'SF_proj' } }],
  })
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean }
  // col2 absent in fieldIds → no fieldId found → no-op
  expect(data.ok).toBe(true)
  expect(mockUpdateField).not.toHaveBeenCalled()
})

test('skips update (ok: true) when slot name is unknown', async () => {
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'unknown-slot', value: 'XL', projectLabel: 'ryvo-tech' }),
  })
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean }
  // unknown slot → no fieldId → no-op, ok: true
  expect(data.ok).toBe(true)
  expect(mockUpdateField).not.toHaveBeenCalled()
})

// Finding 1 — Unknown project 400 guard
test('returns 400 Unknown project when projectLabel has no matching workspace project', async () => {
  // Arrange
  mockReadWorkspace.mockReturnValueOnce({ projects: [defaultProject] })
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL', projectLabel: 'nonexistent' }),
  })
  // Act
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean; error: string }
  // Assert
  expect(res.status).toBe(400)
  expect(data.error).toBe('Unknown project')
  expect(mockUpdateField).not.toHaveBeenCalled()
})

// Finding 2 — Unknown option value 400
test('returns 400 with Unknown value error when value is not in col2Options', async () => {
  // Arrange — defaultProject has col2Options: { XL: 'OPT_XL_PROJ' }, 'XXL' is absent
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XXL', projectLabel: 'ryvo-tech' }),
  })
  // Act
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean; error: string }
  // Assert
  expect(res.status).toBe(400)
  expect(data.error).toContain('Unknown value')
  expect(mockUpdateField).not.toHaveBeenCalled()
})

// Finding 3a — Legacy mode: no projectLabel + not configured → 400
test('returns 400 NOT_CONFIGURED_MSG when no projectLabel and project not configured', async () => {
  // isProjectConfigured defaults to false in beforeEach
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL' }),
  })
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean; error: string }
  expect(res.status).toBe(400)
  expect(data.error).toBe('GitHub Project V2 is not configured. Run `/init` to auto-detect project board settings.')
  expect(mockUpdateField).not.toHaveBeenCalled()
})

// Finding 3b — Legacy mode: no projectLabel + project configured → update proceeds with FIELD_MAP
test('proceeds with FIELD_MAP when no projectLabel and project is configured', async () => {
  mockIsProjectConfigured.mockReturnValue(true)
  const req = new Request('http://localhost/api/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueNumber: 42, field: 'col2', value: 'XL' }),
  })
  const res = await handleUpdate(req)
  const data = (await res.json()) as { ok: boolean }
  expect(data.ok).toBe(true)
  // Legacy mode uses mocked FIELD_MAP constants
  expect(mockUpdateField).toHaveBeenCalledWith('ITEM_42', 'SZ_mock', 'OPT_XL_MOCK', undefined)
})
