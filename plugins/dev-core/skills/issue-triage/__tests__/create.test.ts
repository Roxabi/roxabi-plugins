import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Provide project config so field updates work in tests
process.env.GITHUB_REPO = 'Test/test-repo'
process.env.PROJECT_ID = 'PVT_test'
process.env.STATUS_FIELD_ID = 'SF_test'
process.env.SIZE_FIELD_ID = 'SZF_test'
process.env.PRIORITY_FIELD_ID = 'PF_test'
process.env.STATUS_OPTIONS_JSON = JSON.stringify({
  Backlog: 'status-backlog',
  Analysis: 'status-analysis',
  Specs: 'status-specs',
  'In Progress': 'status-inprog',
  Review: 'status-review',
  Done: 'status-done',
})
process.env.SIZE_OPTIONS_JSON = JSON.stringify({
  XS: 'size-xs',
  S: 'size-s',
  M: 'size-m',
  L: 'size-l',
  XL: 'size-xl',
})
process.env.PRIORITY_OPTIONS_JSON = JSON.stringify({
  'P0 - Urgent': 'pri-urgent',
  'P1 - High': 'pri-high',
  'P2 - Medium': 'pri-medium',
  'P3 - Low': 'pri-low',
})

// Mock config before github — Bun hoists vi.mock and validates factory against real module,
// which would load config.ts before process.env assignments run. Mocking config avoids this.
vi.mock('../../shared/config', () => ({
  isProjectConfigured: () => true,
  NOT_CONFIGURED_MSG: 'GitHub Project V2 is not configured.',
  PROJECT_ID: 'PVT_test',
  STATUS_FIELD_ID: 'SF_test',
  SIZE_FIELD_ID: 'SZF_test',
  PRIORITY_FIELD_ID: 'PF_test',
  STATUS_OPTIONS: { Backlog: 'status-backlog', Analysis: 'status-analysis', Specs: 'status-specs', 'In Progress': 'status-inprog', Review: 'status-review', Done: 'status-done' },
  SIZE_OPTIONS: { XS: 'size-xs', S: 'size-s', M: 'size-m', L: 'size-l', XL: 'size-xl' },
  PRIORITY_OPTIONS: { 'P0 - Urgent': 'pri-urgent', 'P1 - High': 'pri-high', 'P2 - Medium': 'pri-medium', 'P3 - Low': 'pri-low' },
  resolveStatus: (input: string) => {
    const canonical = new Set(['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'])
    if (canonical.has(input)) return input
    const aliases: Record<string, string> = { BACKLOG: 'Backlog', ANALYSIS: 'Analysis', SPECS: 'Specs', 'IN PROGRESS': 'In Progress', IN_PROGRESS: 'In Progress', INPROGRESS: 'In Progress', REVIEW: 'Review', DONE: 'Done' }
    return aliases[input.toUpperCase()]
  },
  resolveSize: (input: string) => { const u = input.toUpperCase(); return new Set(['XS', 'S', 'M', 'L', 'XL']).has(u) ? u : undefined },
  resolvePriority: (input: string) => {
    const canonical = new Set(['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'])
    if (canonical.has(input)) return input
    const aliases: Record<string, string> = { URGENT: 'P0 - Urgent', HIGH: 'P1 - High', MEDIUM: 'P2 - Medium', LOW: 'P3 - Low', P0: 'P0 - Urgent', P1: 'P1 - High', P2: 'P2 - Medium', P3: 'P3 - Low' }
    return aliases[input.toUpperCase()]
  },
}))

vi.mock('../../shared/github', () => ({
  createGitHubIssue: vi.fn(),
  getNodeId: vi.fn(),
  addToProject: vi.fn(),
  updateField: vi.fn(),
  addBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
}))

const github = await import('../../shared/github')
const mockCreateGitHubIssue = github.createGitHubIssue as ReturnType<typeof vi.fn>
const mockGetNodeId = github.getNodeId as ReturnType<typeof vi.fn>
const mockAddToProject = github.addToProject as ReturnType<typeof vi.fn>
const mockUpdateField = github.updateField as ReturnType<typeof vi.fn>
const mockAddBlockedBy = github.addBlockedBy as ReturnType<typeof vi.fn>
const mockAddSubIssue = github.addSubIssue as ReturnType<typeof vi.fn>

const { createIssue } = await import('../lib/create')

function setupMocks() {
  vi.clearAllMocks()
  mockCreateGitHubIssue.mockResolvedValue({
    url: 'https://github.com/test/repo/issues/99',
    number: 99,
  })
  mockGetNodeId.mockImplementation(async (num) => `node-${num}`)
  mockAddToProject.mockResolvedValue('item-99')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('issue-triage/create > basic creation', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('creates an issue with title', async () => {
    await createIssue(['--title', 'Test issue'])
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith('Test issue', undefined, undefined)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Created #99'))
  })

  it('adds issue to project board', async () => {
    await createIssue(['--title', 'Test'])
    expect(mockGetNodeId).toHaveBeenCalledWith(99)
    expect(mockAddToProject).toHaveBeenCalledWith('node-99')
  })

  it('sets size on creation', async () => {
    await createIssue(['--title', 'Test', '--size', 'M'])
    expect(mockUpdateField).toHaveBeenCalledWith('item-99', expect.any(String), 'size-m')
  })

  it('sets priority on creation', async () => {
    await createIssue(['--title', 'Test', '--priority', 'High'])
    expect(mockUpdateField).toHaveBeenCalledWith('item-99', expect.any(String), 'pri-high')
  })
})

describe('issue-triage/create > relationships', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('sets parent relationship', async () => {
    await createIssue(['--title', 'Child', '--parent', '50'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-50', 'node-99')
  })

  it('adds children', async () => {
    await createIssue(['--title', 'Epic', '--add-child', '60,61'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-99', 'node-60')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-99', 'node-61')
  })

  it('sets blocked-by dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocked-by', '10,11'])
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-99', 'node-10')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-99', 'node-11')
  })

  it('sets blocking dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocks', '20'])
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-20', 'node-99')
  })
})

describe('issue-triage/create > options and error handling', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('includes labels in create call', async () => {
    await createIssue(['--title', 'Test', '--label', 'bug,frontend'])
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith('Test', undefined, ['bug', 'frontend'])
  })

  it('includes body in create call', async () => {
    await createIssue(['--title', 'Test', '--body', 'Description here'])
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith('Test', 'Description here', undefined)
  })

  it('continues if project add fails', async () => {
    mockAddToProject.mockRejectedValue(new Error('project error'))
    await createIssue(['--title', 'Test', '--blocked-by', '10'])
    // Should still set dependencies
    expect(mockAddBlockedBy).toHaveBeenCalled()
  })
})
