import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Integration tests for multi-project batched GraphQL (SC-10, SC-11) plus the
// default single-project (`!opts.all`) cwd-resolution path.

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
// Batched GraphQL response fixture
// ---------------------------------------------------------------------------

function makeBatchedResponse(project0Nodes = [], project1Nodes = []) {
  return {
    data: {
      project0: {
        items: {
          nodes: project0Nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      project1: {
        items: {
          nodes: project1Nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }
}

function makeIssueNode(number: number, title: string) {
  return {
    content: {
      number,
      title,
      state: 'OPEN',
      url: `https://github.com/Roxabi/repo/issues/${number}`,
      subIssues: { nodes: [] },
      parent: null,
      blockedBy: { nodes: [] },
      blocking: { nodes: [] },
    },
    fieldValues: {
      nodes: [
        { name: 'Backlog', field: { name: 'Status' } },
        { name: 'P1 - High', field: { name: 'Priority' } },
        { name: 'M', field: { name: 'Size' } },
      ],
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
// Integration tests — issues command with workspace fixture (SC-10, SC-11)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

describe('issues command - batched GraphQL', () => {
  let fetchMock: ReturnType<typeof mock>

  beforeEach(() => {
    fetchMock = mock(async (_url: string, _opts: RequestInit) => ({
      ok: true,
      json: async () => makeBatchedResponse(),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('SC-10: fires exactly 1 HTTP request for a 2-project workspace', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    await runIssuesCommand({ workspace: TWO_PROJECT_WORKSPACE, format: 'table', all: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('SC-10: the single request targets the GitHub GraphQL endpoint', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    await runIssuesCommand({ workspace: TWO_PROJECT_WORKSPACE, format: 'table', all: true })

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
  })

  it('SC-11: output contains the project label for each project when issues are present', async () => {
    const project0Issue = makeIssueNode(1, 'Frontend login page')
    const project1Issue = makeIssueNode(2, 'Backend auth endpoint')

    fetchMock = mock(async () => ({
      ok: true,
      json: async () => makeBatchedResponse([project0Issue], [project1Issue]),
    }))
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
    const project0Issue = makeIssueNode(10, 'Add dark mode')
    const project1Issue = makeIssueNode(20, 'Fix DB connection pool')

    fetchMock = mock(async () => ({
      ok: true,
      json: async () => makeBatchedResponse([project0Issue], [project1Issue]),
    }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { runIssuesCommand } = await import('../commands/issues')

    const output = await runIssuesCommand({
      workspace: TWO_PROJECT_WORKSPACE,
      format: 'table',
      all: true,
    })

    expect(output).toContain('#10')
    expect(output).toContain('#20')
    // Each issue lives under its project's `## <label>` section header — assert
    // both the label appears AND it appears before the issue number for that project.
    expect(output.indexOf('## frontend')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('## backend')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('## frontend')).toBeLessThan(output.indexOf('#10'))
    expect(output.indexOf('## backend')).toBeLessThan(output.indexOf('#20'))
  })

  it('returns empty table gracefully when all projects have no issues', async () => {
    const { runIssuesCommand } = await import('../commands/issues')

    const output = await runIssuesCommand({
      workspace: TWO_PROJECT_WORKSPACE,
      format: 'table',
      all: true,
    })

    expect(typeof output).toBe('string')
    expect(output).toContain('0 issues')
  })

  // Default (`!opts.all`) path: cwd → resolveCurrentProject (via localPath match) →
  // single-project ISSUES_QUERY. Uses localPath matching cwd so resolution does not
  // shell out to git remote. Response shape differs from the batched path.
  it('default path: resolves cwd via localPath and fetches a single project', async () => {
    const issue = makeIssueNode(42, 'Single project test')
    fetchMock = mock(async () => ({
      ok: true,
      json: async () => ({
        data: {
          node: {
            items: {
              nodes: [issue],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
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
})
