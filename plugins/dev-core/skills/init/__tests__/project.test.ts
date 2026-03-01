import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../shared/github', () => ({
  run: vi.fn(),
}))

describe('createProject', () => {
  let mockRun: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
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
            { id: 'F_status', name: 'Status', options: [{ id: 'opt1', name: 'Backlog' }, { id: 'opt2', name: 'Done' }] },
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
