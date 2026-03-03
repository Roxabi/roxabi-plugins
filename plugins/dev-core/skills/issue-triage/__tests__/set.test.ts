import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Provide project config so field updates work in tests
process.env.GITHUB_REPO = 'Test/test-repo'
process.env.GH_PROJECT_ID = 'PVT_test'
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
  GH_PROJECT_ID: 'PVT_test',
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
const mockGetItemId = github.getItemId as ReturnType<typeof vi.fn>
const mockGetNodeId = github.getNodeId as ReturnType<typeof vi.fn>
const mockUpdateField = github.updateField as ReturnType<typeof vi.fn>
const mockAddBlockedBy = github.addBlockedBy as ReturnType<typeof vi.fn>
const mockRemoveBlockedBy = github.removeBlockedBy as ReturnType<typeof vi.fn>
const mockAddSubIssue = github.addSubIssue as ReturnType<typeof vi.fn>
const mockRemoveSubIssue = github.removeSubIssue as ReturnType<typeof vi.fn>
const mockGetParentNumber = github.getParentNumber as ReturnType<typeof vi.fn>

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
