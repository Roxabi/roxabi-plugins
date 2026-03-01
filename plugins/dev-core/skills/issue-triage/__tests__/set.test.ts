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

vi.mock('../../shared/github', () => ({
  getItemId: vi.fn(),
  getNodeId: vi.fn(),
  getParentNumber: vi.fn(),
  updateField: vi.fn(),
  addBlockedBy: vi.fn(),
  removeBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
  removeSubIssue: vi.fn(),
}))

const github = await import('../../shared/github')
const mockGetItemId = vi.mocked(github.getItemId)
const mockGetNodeId = vi.mocked(github.getNodeId)
const mockUpdateField = vi.mocked(github.updateField)
const mockAddBlockedBy = vi.mocked(github.addBlockedBy)
const mockRemoveBlockedBy = vi.mocked(github.removeBlockedBy)
const mockAddSubIssue = vi.mocked(github.addSubIssue)
const mockRemoveSubIssue = vi.mocked(github.removeSubIssue)
const mockGetParentNumber = vi.mocked(github.getParentNumber)

const { setIssue } = await import('../lib/set')

function setupMocks() {
  vi.clearAllMocks()
  mockGetItemId.mockResolvedValue('item-123')
  mockGetNodeId.mockImplementation(async (num) => `node-${num}`)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('issue-triage/set > field updates', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('updates size field', async () => {
    await setIssue(['42', '--size', 'M'])
    expect(mockGetItemId).toHaveBeenCalledWith(42)
    expect(mockUpdateField).toHaveBeenCalledWith('item-123', expect.any(String), 'size-m')
  })

  it('updates priority field with alias', async () => {
    await setIssue(['42', '--priority', 'High'])
    expect(mockUpdateField).toHaveBeenCalledWith('item-123', expect.any(String), 'pri-high')
  })

  it('updates status with case normalization', async () => {
    await setIssue(['42', '--status', 'In Progress'])
    expect(mockUpdateField).toHaveBeenCalledWith('item-123', expect.any(String), 'status-inprog')
  })
})

describe('issue-triage/set > dependencies', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('adds blocked-by dependency', async () => {
    await setIssue(['42', '--blocked-by', '100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(42)
    expect(mockGetNodeId).toHaveBeenCalledWith(100)
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-42', 'node-100')
  })

  it('adds multiple comma-separated blocked-by deps', async () => {
    await setIssue(['42', '--blocked-by', '100,101,102'])
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(3)
  })

  it('adds blocking dependency (reverse direction)', async () => {
    await setIssue(['42', '--blocks', '50'])
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-50', 'node-42')
  })

  it('removes blocked-by dependency', async () => {
    await setIssue(['42', '--rm-blocked-by', '100'])
    expect(mockRemoveBlockedBy).toHaveBeenCalledWith('node-42', 'node-100')
  })

  it('removes blocking dependency', async () => {
    await setIssue(['42', '--rm-blocks', '50'])
    expect(mockRemoveBlockedBy).toHaveBeenCalledWith('node-50', 'node-42')
  })
})

describe('issue-triage/set > parent-child relationships', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('sets parent relationship', async () => {
    await setIssue(['42', '--parent', '10'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-10', 'node-42')
  })

  it('adds children', async () => {
    await setIssue(['42', '--add-child', '50,51'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-50')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-51')
  })

  it('removes parent', async () => {
    mockGetParentNumber.mockResolvedValue(10)
    await setIssue(['42', '--rm-parent'])
    expect(mockRemoveSubIssue).toHaveBeenCalledWith('node-10', 'node-42')
  })

  it('removes children', async () => {
    await setIssue(['42', '--rm-child', '50'])
    expect(mockRemoveSubIssue).toHaveBeenCalledWith('node-42', 'node-50')
  })
})

describe('issue-triage/set > combined flags', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('handles multiple flags at once', async () => {
    await setIssue(['42', '--size', 'L', '--priority', 'Urgent', '--blocked-by', '99'])
    expect(mockUpdateField).toHaveBeenCalledTimes(2) // size + priority
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(1)
  })

  it('strips # prefix from issue numbers', async () => {
    await setIssue(['42', '--blocked-by', '#100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(100)
  })
})
