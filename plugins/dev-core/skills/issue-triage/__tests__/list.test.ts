import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock shared/github before importing list module
vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(),
  run: vi.fn(),
}))

const { ghGraphQL } = await import('../../shared/adapters/github-adapter')
const mockGhGraphQL = ghGraphQL as ReturnType<typeof vi.fn>

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
  state = 'OPEN',
  labels: string[] = [],
  subIssues: { number: number; state: string; title: string }[] = [],
) {
  return {
    id: `item-${number}`,
    content: {
      number,
      title,
      body: '',
      state,
      url: `https://github.com/test/repo/issues/${number}`,
      labels: { nodes: labels.map((name) => ({ name })) },
      subIssues: { nodes: subIssues },
      parent: null,
    },
    fieldValues: {
      nodes: [
        ...(size ? [{ name: size, field: { name: 'Size' } }] : []),
        ...(priority ? [{ name: priority, field: { name: 'Priority' } }] : []),
      ],
    },
  }
}

describe('issue-triage/list --untriaged > filtering', () => {
  beforeEach(() => mockGhGraphQL.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('filters untriaged issues (missing size or priority)', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([
        makeItem(1, 'Has both', 'M', 'P1 - High'),
        makeItem(2, 'Missing size', null, 'P2 - Medium'),
        makeItem(3, 'Missing priority', 'S', null),
        makeItem(4, 'Missing both', null, null),
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

  it('ignores closed issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([makeItem(1, 'Closed no size', null, 'P1 - High', 'CLOSED')]),
    )

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
    mockGhGraphQL.mockResolvedValueOnce(makeProjectResponse([makeItem(5, 'Untriaged', null, null)]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues(['--json'])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('')
    const parsed = JSON.parse(output)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].number).toBe(5)
    expect(parsed[0]).toHaveProperty('mismatch')
    expect(typeof parsed[0].mismatch).toBe('boolean')
    consoleSpy.mockRestore()
  })

  it('reports all triaged when no untriaged issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeProjectResponse([makeItem(1, 'Triaged', 'M', 'P1 - High')]))

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
      makeProjectResponse([
        makeItem(1, 'Has both', 'M', 'P1 - High'),
        makeItem(2, 'Missing size', null, 'P2 - Medium'),
        makeItem(3, 'Closed', 'S', 'P1 - High', 'CLOSED'),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('#1')
    expect(output).toContain('#2')
    expect(output).not.toContain('#3')
    expect(output).toContain('2 open issues')
    consoleSpy.mockRestore()
  })

  it('shows "No open issues." when all issues are closed', async () => {
    mockGhGraphQL.mockResolvedValueOnce(makeProjectResponse([makeItem(1, 'Closed', 'M', 'P1 - High', 'CLOSED')]))

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('No open issues.')
    consoleSpy.mockRestore()
  })

  it('indents children under their parent', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([
        makeItem(10, 'Parent issue', 'L', 'P1 - High', 'OPEN', [], [{ number: 11, state: 'OPEN', title: 'Child' }]),
        makeItem(11, 'Child issue', 'S', 'P2 - Medium'),
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
    // Parent has no leading spaces, child is indented
    expect(parentLine?.startsWith('#10')).toBe(true)
    expect(childLine?.startsWith('  #11')).toBe(true)
    consoleSpy.mockRestore()
  })

  it('shows "… ✓ Done" hint when parent has at least one closed child', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([
        makeItem(
          20,
          'Epic',
          'XL',
          'P1 - High',
          'OPEN',
          [],
          [
            { number: 21, state: 'CLOSED', title: 'Done child' },
            { number: 22, state: 'OPEN', title: 'Open child' },
          ],
        ),
        makeItem(22, 'Open child', 'S', 'P2 - Medium'),
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
      makeProjectResponse([
        makeItem(30, 'Epic', 'L', 'P1 - High', 'OPEN', [], [{ number: 31, state: 'OPEN', title: 'Child' }]),
        makeItem(31, 'Child', 'S', 'P2 - Medium'),
      ]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).not.toContain('\u2026 \u2713 Done')
    consoleSpy.mockRestore()
  })
})

describe('issue-triage/list > priority mismatch detection', () => {
  it('no mismatch when field and label agree', async () => {
    const { detectPriorityMismatch } = await import('../lib/list')
    const item = makeItem(1, 'Test', 'M', 'P1 - High', 'OPEN', ['P1-high'])
    expect(detectPriorityMismatch(item)).toBe(false)
  })

  it('mismatch when field and label disagree', async () => {
    const { detectPriorityMismatch } = await import('../lib/list')
    const item = makeItem(1, 'Test', 'M', 'P1 - High', 'OPEN', ['P2-medium'])
    expect(detectPriorityMismatch(item)).toBe(true)
  })

  it('mismatch when field exists but no priority label', async () => {
    const { detectPriorityMismatch } = await import('../lib/list')
    const item = makeItem(1, 'Test', 'M', 'P1 - High', 'OPEN', ['bug'])
    expect(detectPriorityMismatch(item)).toBe(true)
  })

  it('mismatch when priority label exists but no field', async () => {
    const { detectPriorityMismatch } = await import('../lib/list')
    const item = makeItem(1, 'Test', 'M', null, 'OPEN', ['P0-critical'])
    expect(detectPriorityMismatch(item)).toBe(true)
  })

  it('no mismatch when neither field nor label exists', async () => {
    const { detectPriorityMismatch } = await import('../lib/list')
    const item = makeItem(1, 'Test', 'M', null, 'OPEN')
    expect(detectPriorityMismatch(item)).toBe(false)
  })

  it('shows warning marker in tree output for mismatched issues', async () => {
    mockGhGraphQL.mockResolvedValueOnce(
      makeProjectResponse([makeItem(10, 'Mismatched', null, 'P1 - High', 'OPEN', ['P3-low'])]),
    )

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { listIssues } = await import('../lib/list')
    await listIssues([])

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n')
    expect(output).toContain('\u26a0')
    consoleSpy.mockRestore()
  })
})
