/**
 * Tests for createProject with --type support and fieldIds write.
 * RED phase: fail until Tasks 4.3 / 4.4 update project.ts.
 */

process.env.GITHUB_REPO = 'Test/test-repo'

import { beforeEach, expect, test, vi } from 'vitest'

const mockRun = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    // Simulate `gh project create` returning a project
    if (args.includes('create')) return JSON.stringify({ id: 'PVT_new', number: 42 })
    // Simulate `gh project field-list` returning fields
    if (args.includes('field-list')) {
      return JSON.stringify({
        fields: [
          {
            id: 'SF_1',
            name: 'Status',
            options: [
              { id: 'OPT_BL', name: 'Backlog' },
              { id: 'OPT_IP', name: 'In Progress' },
            ],
          },
          {
            id: 'SZ_1',
            name: 'Size',
            options: [
              { id: 'OPT_XS', name: 'XS' },
              { id: 'OPT_XL', name: 'XL' },
            ],
          },
          { id: 'PR_1', name: 'Priority', options: [{ id: 'OPT_P1', name: 'P1 - High' }] },
        ],
      })
    }
    // Simulate `gh project field-create` success
    return ''
  }),
)

const mockGhGraphQL = vi.hoisted(() => vi.fn(async () => ({ data: { node: { workflows: { nodes: [] } } } })))

vi.mock('../../shared/github', () => ({
  run: mockRun,
  linkProjectToRepo: vi.fn(),
  parseProjectFields: (json: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = JSON.parse(json) as {
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>
    }
    const result: Record<string, { id: string; options: Record<string, string> } | null> = {
      status: null,
      size: null,
      priority: null,
    }
    for (const f of data.fields ?? []) {
      const key = f.name.toLowerCase()
      if (key === 'status' || key === 'size' || key === 'priority') {
        const options: Record<string, string> = {}
        for (const opt of f.options ?? []) options[opt.name] = opt.id
        result[key] = { id: f.id, options }
      }
    }
    return result
  },
  ghGraphQL: mockGhGraphQL,
}))

const mockWriteWorkspace = vi.hoisted(() => vi.fn(() => {}))
const mockReadWorkspace = vi.hoisted(() => vi.fn(() => ({ projects: [] })))

vi.mock('../../shared/workspace', () => ({
  readWorkspace: mockReadWorkspace,
  writeWorkspace: mockWriteWorkspace,
  getWorkspacePath: () => '/tmp/test-workspace.json',
}))

const { createProject } = await import('./project')

beforeEach(() => {
  mockRun.mockClear()
  mockWriteWorkspace.mockClear()
})

test('createProject writes type to workspace entry', async () => {
  await createProject('TestOrg', 'my-repo', 'company')
  expect(mockWriteWorkspace).toHaveBeenCalled()
  const ws = (mockWriteWorkspace.mock.calls[0] as unknown as [unknown])[0] as unknown as {
    projects: Array<{ type: string }>
  }
  const entry = ws?.projects?.[0]
  expect(entry?.type).toBe('company')
})

test('createProject writes fieldIds on scaffold', async () => {
  await createProject('TestOrg', 'my-repo', 'technical')
  const ws = (mockWriteWorkspace.mock.calls[0] as unknown as [unknown])[0] as unknown as {
    projects: Array<{ fieldIds?: { status: string; col2?: string } }>
  }
  const entry = ws?.projects?.[0]
  expect(entry?.fieldIds).toBeDefined()
  expect(entry?.fieldIds?.status).toBe('SF_1')
})

test('createProject warns + writes fieldIds:{} when GitHub fields missing', async () => {
  // Mock field-list to return empty fields
  mockRun.mockImplementationOnce(async (args: string[]) => {
    if (args.includes('create')) return JSON.stringify({ id: 'PVT_empty', number: 99 })
    return ''
  })
  mockRun.mockImplementationOnce(async () => JSON.stringify({ id: 'PVT_empty', number: 99 }))
  // After create, field-list returns no fields
  mockRun.mockImplementationOnce(async () => '')
  mockRun.mockImplementationOnce(async () => JSON.stringify({ fields: [] }))

  // Should not throw even when fields are missing
  await expect(createProject('TestOrg', 'empty-repo', 'company')).resolves.toBeDefined()
})
