import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/github', () => ({
  createGitHubIssue: vi.fn(),
  getNodeId: vi.fn(),
  addToProject: vi.fn(),
  updateField: vi.fn(),
  addBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
}))

const github = await import('../../shared/github')
const mockCreateGitHubIssue = vi.mocked(github.createGitHubIssue)
const mockGetNodeId = vi.mocked(github.getNodeId)
const mockAddToProject = vi.mocked(github.addToProject)
const mockUpdateField = vi.mocked(github.updateField)
const mockAddBlockedBy = vi.mocked(github.addBlockedBy)
const mockAddSubIssue = vi.mocked(github.addSubIssue)

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
    expect(mockUpdateField).toHaveBeenCalledWith('item-99', expect.any(String), 'e2c52fb1')
  })

  it('sets priority on creation', async () => {
    await createIssue(['--title', 'Test', '--priority', 'High'])
    expect(mockUpdateField).toHaveBeenCalledWith('item-99', expect.any(String), '742ac87b')
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
