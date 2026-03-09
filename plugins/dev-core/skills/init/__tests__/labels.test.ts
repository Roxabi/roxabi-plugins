import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/adapters/github-adapter', () => ({
  run: vi.fn(),
}))

describe('createLabels', () => {
  let mockRun: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    const github = await import('../../shared/adapters/github-adapter')
    mockRun = github.run as ReturnType<typeof vi.fn>
    mockRun.mockResolvedValue('')
  })

  it('creates all 11 labels with scope "all"', async () => {
    const { createLabels } = await import('../lib/labels')
    const result = await createLabels('Org/repo', 'all')
    expect(result.created).toHaveLength(11)
    expect(mockRun).toHaveBeenCalledTimes(11)
  })

  it('creates only type labels (6) with scope "type"', async () => {
    const { createLabels } = await import('../lib/labels')
    const result = await createLabels('Org/repo', 'type')
    expect(result.created).toHaveLength(6)
  })

  it('creates only area labels (5) with scope "area"', async () => {
    const { createLabels } = await import('../lib/labels')
    const result = await createLabels('Org/repo', 'area')
    expect(result.created).toHaveLength(5)
  })

  it('passes --force flag to gh label create', async () => {
    const { createLabels } = await import('../lib/labels')
    await createLabels('Org/repo', 'area')

    const firstCall = mockRun.mock.calls[0][0] as string[]
    expect(firstCall).toContain('--force')
    expect(firstCall).toContain('--repo')
    expect(firstCall).toContain('Org/repo')
  })

  it('continues when a label creation fails', async () => {
    mockRun.mockRejectedValueOnce(new Error('already exists'))
    mockRun.mockResolvedValue('')

    const { createLabels } = await import('../lib/labels')
    const result = await createLabels('Org/repo', 'type')
    // First label fails, remaining 5 succeed
    expect(result.created).toHaveLength(5)
  })
})
