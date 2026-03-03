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
  UPDATE_PROJECT_WORKFLOW_MUTATION: 'UPDATE_PROJECT_WORKFLOW_MUTATION',
}))

describe('createProject', () => {
  let mockRun: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const github = await import('../../shared/github')
    mockRun = github.run as ReturnType<typeof vi.fn>
  })

  it('creates project and returns IDs', async () => {
    const calls: string[][] = []
    mockRun.mockImplementation(async (cmd: string[]) => {
      calls.push(cmd)
      const joined = cmd.join(' ')
      if (joined.includes('project create')) return JSON.stringify({ id: 'PVT_new', number: 42 })
      if (joined.includes('field-list')) {
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

    const { createProject } = await import('../lib/project')
    const result = await createProject('TestOrg', 'test-repo')

    expect(result.id).toBe('PVT_new')
    expect(result.number).toBe(42)
    expect(result.fields.status.id).toBe('F_status')
    expect(result.fields.status.options).toEqual({ Backlog: 'opt1', Done: 'opt2' })
    expect(result.fields.size.id).toBe('F_size')
    expect(result.fields.priority.id).toBe('F_priority')

    // Verify field-create was called 3 times
    const fieldCreates = calls.filter((c) => c.join(' ').includes('field-create'))
    expect(fieldCreates).toHaveLength(3)
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

describe('enableProjectWorkflow', () => {
  let mockGhGraphQL: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const github = await import('../../shared/github')
    mockGhGraphQL = github.ghGraphQL as ReturnType<typeof vi.fn>
  })

  it('enables a workflow and returns updated state', async () => {
    mockGhGraphQL.mockResolvedValueOnce({
      data: {
        updateProjectV2Workflow: {
          projectV2Workflow: { id: 'PWF_1', name: 'Auto-add to project', enabled: true },
        },
      },
    })

    const { enableProjectWorkflow } = await import('../lib/project')
    const result = await enableProjectWorkflow('PWF_1')

    expect(result).toEqual({ id: 'PWF_1', name: 'Auto-add to project', enabled: true })
    expect(mockGhGraphQL).toHaveBeenCalledWith('UPDATE_PROJECT_WORKFLOW_MUTATION', {
      workflowId: 'PWF_1',
      enabled: true,
    })
  })
})
