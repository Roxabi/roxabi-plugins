import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shared/github before importing list module
vi.mock('../../shared/github', () => ({
  ghGraphQL: vi.fn(),
  run: vi.fn(),
}))

const { ghGraphQL } = await import('../../shared/github')
const mockGhGraphQL = vi.mocked(ghGraphQL)

function makeProjectResponse(items: unknown[]) {
  return {
    data: {
      node: {
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: items,
        },
      },
    },
  }
}

function makeItem(
  number: number,
  title: string,
  size: string | null,
  priority: string | null,
  state = 'OPEN'
) {
  return {
    id: `item-${number}`,
    content: { number, title, body: '', state },
    fieldValues: {
      nodes: [
        ...(size ? [{ name: size, field: { name: 'Size' } }] : []),
        ...(priority ? [{ name: priority, field: { name: 'Priority' } }] : []),
      ],
    },
  }
}

describe('issue-triage/list > filtering', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('filters untriaged issues (missing size or priority)', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([
        makeItem(1, 'Has both', 'M', 'P1 - High'),
        makeItem(2, 'Missing size', null, 'P2 - Medium'),
        makeItem(3, 'Missing priority', 'S', null),
        makeItem(4, 'Missing both', null, null),
      ])
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#2')
    expect(output).toContain('#3')
    expect(output).toContain('#4')
    expect(output).not.toContain('#1 ')
    expect(output).toContain('3 to triage')
    consoleSpy.mockRestore()
  })

  it('ignores closed issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([makeItem(1, 'Closed no size', null, 'P1 - High', 'CLOSED')])
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('All issues triaged')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list > output format', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('outputs JSON when --json flag is provided', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeProjectResponse([makeItem(5, 'Untriaged', null, null)]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--json'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].number).toBe(5)
    consoleSpy.mockRestore()
  })

  it('reports all triaged when no untriaged issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([makeItem(1, 'Triaged', 'M', 'P1 - High')])
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('All issues triaged')
    consoleSpy.mockRestore()
  })
})
