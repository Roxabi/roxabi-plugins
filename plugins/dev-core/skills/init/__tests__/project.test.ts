import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/github', () => ({
  run: vi.fn(),
  ghGraphQL: vi.fn(),
  parseProjectFields: (json: string) => {
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
}))

vi.mock('../../shared/queries', () => ({
  PROJECT_WORKFLOWS_QUERY: 'PROJECT_WORKFLOWS_QUERY',
  UPDATE_FIELD_OPTIONS_MUTATION: 'UPDATE_FIELD_OPTIONS_MUTATION',
}))

vi.mock('../../shared/workspace', () => ({
  readWorkspace: vi.fn(() => ({ projects: [] })),
  writeWorkspace: vi.fn(),
  getWorkspacePath: () => '/tmp/test-workspace.json',
}))

describe('createProject', () => {
  let mockRun: ReturnType<typeof vi.fn>
  let mockGhGraphQL: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const github = await import('../../shared/github')
    mockRun = github.run as ReturnType<typeof vi.fn>
    mockGhGraphQL = github.ghGraphQL as ReturnType<typeof vi.fn>
  })

  it('creates project, updates existing Status field, and creates Size/Priority via field-create', async () => {
    const calls: string[][] = []
    let fieldListCallCount = 0

    mockRun.mockImplementation(async (cmd: string[]) => {
      calls.push(cmd)
      const joined = cmd.join(' ')
      if (joined.includes('project create')) return JSON.stringify({ id: 'PVT_new', number: 42 })
      if (joined.includes('project link')) return ''
      if (joined.includes('field-list')) {
        fieldListCallCount++
        if (fieldListCallCount === 1) {
          // First call: GitHub's default fields after project creation
          return JSON.stringify({
            fields: [{ id: 'F_status', name: 'Status', options: [{ id: 'opt_todo', name: 'Todo' }] }],
          })
        }
        // Subsequent calls: all fields present after creates
        return JSON.stringify({
          fields: [
            {
              id: 'F_status',
              name: 'Status',
              options: [
                { id: 'opt1', name: 'Backlog' },
                { id: 'opt2', name: 'Done' },
              ],
            },
            { id: 'F_size', name: 'Size', options: [{ id: 'opt3', name: 'S' }] },
            { id: 'F_priority', name: 'Priority', options: [{ id: 'opt4', name: 'P0 - Urgent' }] },
          ],
        })
      }
      return ''
    })

    mockGhGraphQL.mockResolvedValue({
      data: { updateProjectV2Field: { projectV2Field: { id: 'F_status', name: 'Status', options: [] } } },
    })

    const { createProject } = await import('../lib/project')
    const result = await createProject('TestOrg', 'test-repo')

    expect(result.id).toBe('PVT_new')
    expect(result.number).toBe(42)
    expect(result.fields.status.id).toBe('F_status')
    expect(result.fields.size.id).toBe('F_size')
    expect(result.fields.priority.id).toBe('F_priority')

    // Status already existed — updated via GraphQL, not field-create
    expect(mockGhGraphQL).toHaveBeenCalledWith(
      'UPDATE_FIELD_OPTIONS_MUTATION',
      expect.objectContaining({ fieldId: 'F_status' }),
    )
    const fieldCreates = calls.filter((c) => c.join(' ').includes('field-create'))
    expect(fieldCreates).toHaveLength(2) // Size + Priority only
  })
})

describe('listProjectWorkflows', () => {
  let mockGhGraphQL: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const github = await import('../../shared/github')
    mockGhGraphQL = github.ghGraphQL as ReturnType<typeof vi.fn>
  })

  it('returns workflows from project', async () => {
    mockGhGraphQL.mockResolvedValueOnce({
      data: {
        node: {
          workflows: {
            nodes: [
              { id: 'PWF_1', name: 'Auto-add to project', enabled: false },
              { id: 'PWF_2', name: 'Auto-archive items', enabled: true },
            ],
          },
        },
      },
    })

    const { listProjectWorkflows } = await import('../lib/project')
    const result = await listProjectWorkflows('PVT_xxx')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: 'PWF_1', name: 'Auto-add to project', enabled: false })
    expect(result[1].enabled).toBe(true)
  })
})
