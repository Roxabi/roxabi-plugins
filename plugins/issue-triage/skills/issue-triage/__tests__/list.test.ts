import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.GITHUB_REPO = 'Test/test-repo'

vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(),
}))

const { ghGraphQL } = await import('../../shared/adapters/github-adapter')
const mockGhGraphQL = ghGraphQL as ReturnType<typeof vi.fn>

function makeIssuesResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
) {
  return {
    data: {
      repository: {
        issues: {
          pageInfo,
          nodes,
        },
      },
    },
  }
}

function makeIssue(
  number: number,
  title: string,
  labels: string[] = [],
  subIssues: { number: number; state: string; title: string }[] = [],
  state = 'OPEN',
) {
  return {
    number,
    title,
    state,
    labels: { nodes: labels.map((name) => ({ name })) },
    parent: null,
    subIssues: { nodes: subIssues },
  }
}

describe('issue-triage/list --untriaged > filtering', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('filters untriaged issues (missing size or priority)', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(1, 'Has both', ['size:S', 'P1-high']),
        makeIssue(2, 'Missing size', ['P2-medium']),
        makeIssue(3, 'Missing priority', ['size:S']),
        makeIssue(4, 'Missing both', []),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--untriaged'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#2')
    expect(output).toContain('#3')
    expect(output).toContain('#4')
    expect(output).not.toContain('#1 ')
    expect(output).toContain('3 to triage')
    consoleSpy.mockRestore()
  })

  it('relies on OPEN query — closed issues are not in the response', async () => {
    // GraphQL states: OPEN already excludes CLOSED; empty open set → all triaged
    mockGhGraphQL.mockResolvedValueOnce(makeIssuesResponse([]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--untriaged'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('All issues triaged')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list --untriaged > output format', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('outputs JSON when --json flag is provided', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeIssuesResponse([makeIssue(5, 'Untriaged', [])]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--json'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].number).toBe(5)
    expect(parsed[0].size).toBeNull()
    expect(parsed[0].priority).toBeNull()
    consoleSpy.mockRestore()
  })

  it('filters JSON with --untriaged when both flags given', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([makeIssue(1, 'Triaged', ['size:S', 'P1-high']), makeIssue(2, 'Needs triage', ['size:S'])]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--json', '--untriaged'])

    const parsed = JSON.parse(consoleSpy.mock.calls.map((c) => c[0]).join(''))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].number).toBe(2)
    consoleSpy.mockRestore()
  })

  it('reports all triaged when no untriaged issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeIssuesResponse([makeIssue(1, 'Triaged', ['size:S', 'P1-high'])]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--untriaged'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('All issues triaged')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list (default tree view)', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('shows all open issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(1, 'Has both', ['size:S', 'P1-high']),
        makeIssue(2, 'Missing size', ['P2-medium']),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#1')
    expect(output).toContain('#2')
    expect(output).toContain('2 open issues')
    consoleSpy.mockRestore()
  })

  it('shows "No open issues." when repository has none', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeIssuesResponse([]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('No open issues.')
    consoleSpy.mockRestore()
  })

  it('indents children under their parent', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(10, 'Parent issue', ['size:F-full', 'P1-high'], [{ number: 11, state: 'OPEN', title: 'Child' }]),
        makeIssue(11, 'Child issue', ['size:S', 'P2-medium']),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const lines = consoleSpy.mock.calls.map((c) => c[0] as string)
    const parentLine = lines.find((l) => l.includes('#10'))
    const childLine = lines.find((l) => l.includes('#11'))
    expect(parentLine).toBeDefined()
    expect(childLine).toBeDefined()
    expect(parentLine?.startsWith('#10')).toBe(true)
    expect(childLine?.startsWith('  #11')).toBe(true)
    consoleSpy.mockRestore()
  })

  it('shows "… ✓ Done" hint when parent has at least one closed child', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(
          20,
          'Epic',
          ['size:F-full', 'P1-high'],
          [
            { number: 21, state: 'CLOSED', title: 'Done child' },
            { number: 22, state: 'OPEN', title: 'Open child' },
          ],
        ),
        makeIssue(22, 'Open child', ['size:S', 'P2-medium']),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('\u2026 \u2713 Done')
    consoleSpy.mockRestore()
  })

  it('does not show done hint when all children are open', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(30, 'Epic', ['size:F-lite', 'P1-high'], [{ number: 31, state: 'OPEN', title: 'Child' }]),
        makeIssue(31, 'Child', ['size:S', 'P2-medium']),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).not.toContain('\u2026 \u2713 Done')
    consoleSpy.mockRestore()
  })

  it('renders priority as P0/P1 short form from labels', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeIssuesResponse([makeIssue(40, 'Labeled', ['size:S', 'P0-critical'])]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('[S][P0]')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list > renderTree cycles', () => {
  it('does not throw on cycle 1↔2 and emits each number at most once', async () => {
    const { renderTree } = await import('../lib/list')
    const row1 = {
      number: 1,
      title: 'One',
      size: 'S' as string | null,
      priority: 'P1' as string | null,
      subIssueNumbers: [2],
      hasDoneChild: false,
    }
    const row2 = {
      number: 2,
      title: 'Two',
      size: 'S' as string | null,
      priority: 'P2' as string | null,
      subIssueNumbers: [1],
      hasDoneChild: false,
    }
    const byNumber = new Map([
      [1, row1],
      [2, row2],
    ])
    const lines: string[] = []
    expect(() => renderTree([row1], byNumber, 0, lines, new Set())).not.toThrow()
    const numbers = lines.map((l) => {
      const m = l.match(/#(\d+)/)
      return m ? Number(m[1]) : null
    })
    expect(numbers.filter((n) => n === 1)).toHaveLength(1)
    expect(numbers.filter((n) => n === 2)).toHaveLength(1)
  })
})

describe('issue-triage/list > cyclic listIssues', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('listIssues still renders a 1↔2 cycle (no empty tree)', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeIssuesResponse([
        makeIssue(1, 'One', ['size:S', 'P1-high'], [{ number: 2, state: 'OPEN', title: 'Two' }]),
        makeIssue(2, 'Two', ['size:S', 'P2-medium'], [{ number: 1, state: 'OPEN', title: 'One' }]),
      ]),
    )
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#1')
    expect(output).toContain('#2')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list > pagination', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('fetches a second page when hasNextPage is true', async () => {
    mockGhGraphQL
      .mockResolvedValueOnce(
        makeIssuesResponse([makeIssue(1, 'Page1', ['size:S', 'P1-high'])], { hasNextPage: true, endCursor: 'CUR1' }),
      )
      .mockResolvedValueOnce(makeIssuesResponse([makeIssue(2, 'Page2', ['size:S', 'P2-medium'])]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    expect(mockGhGraphQL).toHaveBeenCalledTimes(2)
    expect(mockGhGraphQL.mock.calls[1]?.[1]).toMatchObject({ cursor: 'CUR1' })
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#1')
    expect(output).toContain('#2')
    consoleSpy.mockRestore()
  })
})
