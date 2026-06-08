import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Integration tests for per-repo issues fetch (SC-10, SC-11) plus the
// default single-project (!opts.all) cwd-resolution path.

// ---------------------------------------------------------------------------
// Workspace fixture — inline JSON, no real files needed
// ---------------------------------------------------------------------------

const TWO_PROJECT_WORKSPACE = {
  projects: [
    { projectId: 'PVT_kwABC123', label: 'frontend', repo: 'Roxabi/frontend-app' },
    { projectId: 'PVT_kwDEF456', label: 'backend', repo: 'Roxabi/backend-api' },
  ],
}

// ---------------------------------------------------------------------------
// Per-repo response fixture
// ---------------------------------------------------------------------------

function makeIssueNode(number: number, title: string) {
  return {
    number,
    title,
    state: 'OPEN',
    url: `https://github.com/Roxabi/repo/issues/${number}`,
    labels: { nodes: [{ name: 'status:Backlog' }, { name: 'P1-high' }, { name: 'size:F-lite' }] },
    subIssues: { nodes: [] },
    parent: null,
  }
}

function makeRepoResponse(nodes: ReturnType<typeof makeIssueNode>[] = []) {
  return {
    data: {
      repository: {
        issues: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Unit tests — buildBatchedQuery (queries.ts)
// ---------------------------------------------------------------------------

describe('buildBatchedQuery', () => {
  it('returns a query string containing project0: and project1: aliases for 2 project IDs', async () => {
    const { buildBatchedQuery } = await import('../../skills/shared/queries')
    const projectIds = ['PVT_kwABC123', 'PVT_kwDEF456']

    const query = buildBatchedQuery(projectIds)

    expect(query).toContain('project0:')
    expect(query).toContain('project1:')
    expect(query).toContain('$project0Id')
    expect(query).toContain('$project1Id')
  })

  it('uses unique variable aliases so both projects appear in a single query document', async () => {
    const { buildBatchedQuery } = await import('../../skills/shared/queries')
    const projectIds = ['PVT_kwABC123', 'PVT_kwDEF456']

    const query = buildBatchedQuery(projectIds)

    const project0Count = (query.match(/project0:/g) ?? []).length
    const project1Count = (query.match(/project1:/g) ?? []).length
    expect(project0Count).toBeGreaterThanOrEqual(1)
    expect(project1Count).toBeGreaterThanOrEqual(1)
  })
})

describe('buildBatchedVariables', () => {
  it('returns empty object for empty array', async () => {
    const { buildBatchedVariables } = await import('../../skills/shared/queries')
    expect(buildBatchedVariables([])).toEqual({})
  })

  it('returns { project0Id: "..." } for a single project ID', async () => {
    const { buildBatchedVariables } = await import('../../skills/shared/queries')
    const result = buildBatchedVariables(['PVT_kwABC123'])
    expect(result).toEqual({ project0Id: 'PVT_kwABC123' })
  })

  it('returns correctly keyed entries for N project IDs', async () => {
    const { buildBatchedVariables } = await import('../../skills/shared/queries')
    const ids = ['PVT_kwABC123', 'PVT_kwDEF456', 'PVT_kwGHI789']
    const result = buildBatchedVariables(ids)
    expect(result).toEqual({
      project0Id: 'PVT_kwABC123',
      project1Id: 'PVT_kwDEF456',
      project2Id: 'PVT_kwGHI789',
    })
  })
})

// ---------------------------------------------------------------------------
// Integration tests — issues command with per-repo fetch (SC-10, SC-11)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

describe('issues command - per-repo fetch', () => {
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async (_url: string, _opts: RequestInit) => ({
      ok: true,
      json: async () => makeRepoResponse(),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('SC-10: fires exactly 2 HTTP requests for a 2-project workspace (-A)', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    await runIssuesCommand({ workspace: TWO_PROJECT_WORKSPACE, format: 'table', all: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('SC-10: both requests target the GitHub GraphQL endpoint', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    await runIssuesCommand({ workspace: TWO_PROJECT_WORKSPACE, format: 'table', all: true })

    const calls = fetchMock.mock.calls as [string, RequestInit][]
    expect(calls[0][0]).toBe('https://api.github.com/graphql')
    expect(calls[1][0]).toBe('https://api.github.com/graphql')
  })

  it('SC-11: output contains the project label for each project when issues are present', async () => {
    const frontendIssue = makeIssueNode(1, 'Frontend login page')
    const backendIssue = makeIssueNode(2, 'Backend auth endpoint')

    // Counter closure: call 0 → frontend, call 1 → backend
    let callIndex = 0
    fetchMock = mock(async () => {
      const nodes = callIndex === 0 ? [frontendIssue] : [backendIssue]
      callIndex++
      return { ok: true, json: async () => makeRepoResponse(nodes) }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { runIssuesCommand } = await import('../commands/issues')

    const output = await runIssuesCommand({
      workspace: TWO_PROJECT_WORKSPACE,
      format: 'table',
      all: true,
    })

    expect(output).toContain('frontend')
    expect(output).toContain('backend')
  })

  it('SC-11: each issue is grouped under its project label section', async () => {
    const frontendIssue = makeIssueNode(10, 'Add dark mode')
    const backendIssue = makeIssueNode(20, 'Fix DB connection pool')

    // Counter closure: call 0 → frontend issues, call 1 → backend issues
    let callIndex = 0
    fetchMock = mock(async () => {
      const nodes = callIndex === 0 ? [frontendIssue] : [backendIssue]
      callIndex++
      return { ok: true, json: async () => makeRepoResponse(nodes) }
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { runIssuesCommand } = await import('../commands/issues')

    const output = await runIssuesCommand({
      workspace: TWO_PROJECT_WORKSPACE,
      format: 'table',
      all: true,
    })

    expect(output).toContain('#10')
    expect(output).toContain('#20')
    // Each issue lives under its project's `## <label>` section header
    expect(output.indexOf('## frontend')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('## backend')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('## frontend')).toBeLessThan(output.indexOf('#10'))
    expect(output.indexOf('## backend')).toBeLessThan(output.indexOf('#20'))
  })

  it('returns "0 issues" gracefully when all projects have no issues', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    const output = await runIssuesCommand({
      workspace: TWO_PROJECT_WORKSPACE,
      format: 'table',
      all: true,
    })

    expect(typeof output).toBe('string')
    expect(output).toContain('0 issues')
  })

  // Default (!opts.all) path: cwd → resolveCurrentProject (via localPath match) →
  // single fetchRepoIssues call. Uses localPath matching cwd so resolution does
  // not shell out to git remote.
  it('default path: resolves cwd via localPath and fires exactly 1 fetch', async () => {
    const issue = makeIssueNode(42, 'Single project test')
    fetchMock = mock(async () => ({
      ok: true,
      json: async () => makeRepoResponse([issue]),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const workspace = {
      projects: [
        {
          projectId: 'PVT_kwSINGLE',
          label: 'current-project',
          repo: 'Roxabi/single',
          localPath: process.cwd(),
        },
      ],
    }

    const { runIssuesCommand } = await import('../commands/issues')
    const output = await runIssuesCommand({ workspace, format: 'table' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(output).toContain('## current-project')
    expect(output).toContain('#42')
  })

  it('pagination: accumulates issues across 2 pages and feeds endCursor into the second request', async () => {
    // Arrange
    const page1Node = makeIssueNode(1, 'First page issue')
    const page2Node = makeIssueNode(2, 'Second page issue')
    let callIndex = 0
    fetchMock = mock(async (_url: string, _opts: RequestInit) => {
      const response =
        callIndex === 0
          ? {
              ok: true,
              json: async () => ({
                data: {
                  repository: {
                    issues: {
                      nodes: [page1Node],
                      pageInfo: { hasNextPage: true, endCursor: 'CURSOR1' },
                    },
                  },
                },
              }),
            }
          : {
              ok: true,
              json: async () => ({
                data: {
                  repository: {
                    issues: {
                      nodes: [page2Node],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              }),
            }
      callIndex++
      return response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const workspace = {
      projects: [
        {
          projectId: 'PVT_x',
          label: 'p',
          repo: 'Roxabi/multipage',
          localPath: process.cwd(),
        },
      ],
    }

    const { runIssuesCommand } = await import('../commands/issues')

    // Act
    const output = await runIssuesCommand({ workspace, format: 'table' })

    // Assert: loop made 2 requests (proves pagination was exercised)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Assert: both pages' issues appear in the output
    expect(output).toContain('#1')
    expect(output).toContain('#2')
    // Assert: second request carried the cursor from the first response
    const calls = fetchMock.mock.calls as [string, RequestInit][]
    const secondBody = JSON.parse(calls[1][1].body as string)
    expect(secondBody.variables.cursor).toBe('CURSOR1')
  })

  it('SC7: workspace with no projectId still fetches by repo', async () => {
    const issue = makeIssueNode(99, 'No projectId issue')
    fetchMock = mock(async () => ({
      ok: true,
      json: async () => makeRepoResponse([issue]),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // biome-ignore lint/suspicious/noExplicitAny: intentional — tests runtime resilience when projectId is absent
    const workspace: any = {
      projects: [{ label: 'noid-project', repo: 'Roxabi/noid-repo' }],
    }

    const { runIssuesCommand } = await import('../commands/issues')
    const output = await runIssuesCommand({ workspace, format: 'table', all: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(output).toContain('#99')
  })
})

// ---------------------------------------------------------------------------
// Golden-parity test — label-synthesized RawItem renders identical to hand-built
// ---------------------------------------------------------------------------

describe('golden parity', () => {
  it('formatTable output is byte-identical for label-synthesized vs hand-built RawItem', async () => {
    const { repoIssueToRawItem } = await import('../commands/issues')
    const { formatTable } = await import('../../skills/issues/lib/table-formatter')

    // labelItem: synthesized via repoIssueToRawItem from flat repo node
    const labelItem = repoIssueToRawItem({
      number: 99,
      title: 'Parity check',
      state: 'OPEN',
      url: 'https://github.com/Roxabi/repo/issues/99',
      labels: { nodes: [{ name: 'status:In Progress' }, { name: 'P0-critical' }, { name: 'size:S' }] },
      subIssues: { nodes: [] },
      parent: null,
    })

    // fieldItem: hand-built with explicit fieldValues matching the synthesized output.
    // labelsToFieldValues emits Status, Priority, Size in label-array order.
    // fieldValue() looks up by field.name (order-insensitive) but we match order anyway.
    const fieldItem = {
      content: {
        number: 99,
        title: 'Parity check',
        state: 'OPEN',
        url: 'https://github.com/Roxabi/repo/issues/99',
        labels: { nodes: [{ name: 'status:In Progress' }, { name: 'P0-critical' }, { name: 'size:S' }] },
        subIssues: { nodes: [] },
        parent: null,
        blockedBy: { nodes: [] },
        blocking: { nodes: [] },
      },
      fieldValues: {
        nodes: [
          { field: { name: 'Status' }, name: 'In Progress' },
          { field: { name: 'Priority' }, name: 'P0 - Urgent' },
          { field: { name: 'Size' }, name: 'S' },
        ],
      },
    }

    const opts = { sortBy: 'priority' as const, titleLength: 55 }
    expect(formatTable([labelItem], opts)).toBe(formatTable([fieldItem], opts))
  })
})

// ---------------------------------------------------------------------------
// Unit tests — labelsToFieldValues / repoIssueToRawItem (repo-centric path)
// ---------------------------------------------------------------------------

describe('labelsToFieldValues / repoIssueToRawItem', () => {
  it('maps status label to Status field with canonical key as name', async () => {
    // Arrange
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([{ name: 'status:In Progress' }])
    // Assert
    expect(result).toEqual([{ field: { name: 'Status' }, name: 'In Progress' }])
  })

  it('maps size label to Size field with canonical key as name', async () => {
    // Arrange
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([{ name: 'size:F-lite' }])
    // Assert
    expect(result).toEqual([{ field: { name: 'Size' }, name: 'F-lite' }])
  })

  it('reverse-lookup guard: maps priority label to Priority field with CANONICAL MAP KEY (not the label name)', async () => {
    // Arrange — PRIORITY_LABEL_MAP: 'P1 - High' → 'P1-high'
    // reverse lookup: 'P1-high' label → canonical key 'P1 - High'
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([{ name: 'P1-high' }])
    // Assert: name must be exactly 'P1 - High' (the map KEY), not 'P1-high' or any stripped form
    expect(result).toEqual([{ field: { name: 'Priority' }, name: 'P1 - High' }])
  })

  it('maps lane label to Lane field with lane name stripped of prefix', async () => {
    // Arrange — LANE_LABEL_MAP: 'a1' → 'graph:lane/a1'
    // reverse lookup: 'graph:lane/a1' label → canonical key 'a1'
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([{ name: 'graph:lane/a1' }])
    // Assert
    expect(result).toEqual([{ field: { name: 'Lane' }, name: 'a1' }])
  })

  it('drops unknown labels (e.g. "bug") — returns empty array', async () => {
    // Arrange
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([{ name: 'bug' }])
    // Assert
    expect(result).toEqual([])
  })

  it('handles mixed labels: known ones mapped, unknown ones dropped, order preserved', async () => {
    // Arrange
    const { labelsToFieldValues } = await import('../commands/issues')
    // Act
    const result = labelsToFieldValues([
      { name: 'bug' },
      { name: 'status:Backlog' },
      { name: 'enhancement' },
      { name: 'P2-medium' },
    ])
    // Assert: only the two known labels survive, in original order
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ field: { name: 'Status' }, name: 'Backlog' })
    expect(result[1]).toEqual({ field: { name: 'Priority' }, name: 'P2 - Medium' })
  })

  it('repoIssueToRawItem converts a flat repo issues node to RawItem', async () => {
    // Arrange
    const { repoIssueToRawItem } = await import('../commands/issues')
    const node = {
      number: 42,
      title: 'X',
      state: 'OPEN',
      url: 'https://github.com/Roxabi/repo/issues/42',
      labels: { nodes: [{ name: 'status:Backlog' }, { name: 'P1-high' }, { name: 'size:F-lite' }] },
      subIssues: { nodes: [] },
      parent: null,
    }

    // Act
    const item = repoIssueToRawItem(node)

    // Assert content fields
    expect(item.content.number).toBe(42)
    expect(item.content.title).toBe('X')
    expect(item.content.state).toBe('OPEN')
    // Missing dep collections must default to { nodes: [] }
    expect(item.content.blockedBy).toEqual({ nodes: [] })
    expect(item.content.blocking).toEqual({ nodes: [] })

    // Assert fieldValues: 3 synthesized entries for the 3 known labels
    const fv = item.fieldValues.nodes
    expect(fv).toHaveLength(3)
    // Status
    expect(fv.find((v) => v.field?.name === 'Status')).toEqual({
      field: { name: 'Status' },
      name: 'Backlog',
    })
    // Priority — canonical key must be 'P1 - High' (reverse-lookup guard)
    expect(fv.find((v) => v.field?.name === 'Priority')).toEqual({
      field: { name: 'Priority' },
      name: 'P1 - High',
    })
    // Size
    expect(fv.find((v) => v.field?.name === 'Size')).toEqual({
      field: { name: 'Size' },
      name: 'F-lite',
    })
  })
})
