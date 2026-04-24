import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Provide project config so field updates work in tests
process.env.GITHUB_REPO = 'Test/test-repo'
process.env.GH_PROJECT_ID = 'PVT_test'
process.env.STATUS_FIELD_ID = 'SF_test'
process.env.SIZE_FIELD_ID = 'SZF_test'
process.env.PRIORITY_FIELD_ID = 'PF_test'
process.env.LANE_FIELD_ID = 'LF_test'
process.env.STATUS_OPTIONS_JSON = JSON.stringify({
  Backlog: 'status-backlog',
  Analysis: 'status-analysis',
  Specs: 'status-specs',
  'In Progress': 'status-inprog',
  Review: 'status-review',
  Done: 'status-done',
})
process.env.SIZE_OPTIONS_JSON = JSON.stringify({
  S: 'size-s',
  'F-lite': 'size-f-lite',
  'F-full': 'size-f-full',
})
process.env.PRIORITY_OPTIONS_JSON = JSON.stringify({
  'P0 - Urgent': 'pri-urgent',
  'P1 - High': 'pri-high',
  'P2 - Medium': 'pri-medium',
  'P3 - Low': 'pri-low',
})
process.env.LANE_OPTIONS_JSON = JSON.stringify({
  a1: 'lane-a1',
  a2: 'lane-a2',
  b: 'lane-b',
  c1: 'lane-c1',
  c2: 'lane-c2',
})

// Mock config before github — vi.mock is hoisted before process.env assignments,
// so importOriginal would load config.ts with empty env vars. Manual factory is required.
vi.mock('../../shared/adapters/config-helpers', () => ({
  isProjectConfigured: () => true,
  NOT_CONFIGURED_MSG: 'GitHub Project V2 is not configured.',
  GITHUB_REPO: 'Test/test-repo',
  GH_PROJECT_ID: 'PVT_test',
  STATUS_FIELD_ID: 'SF_test',
  SIZE_FIELD_ID: 'SZF_test',
  PRIORITY_FIELD_ID: 'PF_test',
  LANE_FIELD_ID: 'LF_test',
  STATUS_OPTIONS: {
    Backlog: 'status-backlog',
    Analysis: 'status-analysis',
    Specs: 'status-specs',
    'In Progress': 'status-inprog',
    Review: 'status-review',
    Done: 'status-done',
  },
  SIZE_OPTIONS: { S: 'size-s', 'F-lite': 'size-f-lite', 'F-full': 'size-f-full' },
  PRIORITY_OPTIONS: {
    'P0 - Urgent': 'pri-urgent',
    'P1 - High': 'pri-high',
    'P2 - Medium': 'pri-medium',
    'P3 - Low': 'pri-low',
  },
  LANE_OPTIONS: { a1: 'lane-a1', a2: 'lane-a2', b: 'lane-b', c1: 'lane-c1', c2: 'lane-c2' },
  resolveStatus: (input: string) => {
    const canonical = new Set(['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'])
    if (canonical.has(input)) return input
    const aliases: Record<string, string> = {
      BACKLOG: 'Backlog',
      ANALYSIS: 'Analysis',
      SPECS: 'Specs',
      'IN PROGRESS': 'In Progress',
      IN_PROGRESS: 'In Progress',
      INPROGRESS: 'In Progress',
      REVIEW: 'Review',
      DONE: 'Done',
    }
    return aliases[input.toUpperCase()]
  },
  resolveSize: (input: string) => {
    const valid = new Set(['S', 'F-lite', 'F-full'])
    if (valid.has(input)) return input
    const u = input.toUpperCase().replace(/[-\s]/g, '-')
    if (valid.has(u as 'S' | 'F-lite' | 'F-full')) return u
    // Aliases
    if (u === 'XS') return 'S'
    if (u === 'M') return 'F-lite'
    if (u === 'L' || u === 'XL') return 'F-full'
    return undefined
  },
  resolvePriority: (input: string) => {
    const canonical = new Set(['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'])
    if (canonical.has(input)) return input
    const aliases: Record<string, string> = {
      URGENT: 'P0 - Urgent',
      HIGH: 'P1 - High',
      MEDIUM: 'P2 - Medium',
      LOW: 'P3 - Low',
      P0: 'P0 - Urgent',
      P1: 'P1 - High',
      P2: 'P2 - Medium',
      P3: 'P3 - Low',
    }
    return aliases[input.toUpperCase()]
  },
  resolveLane: (input: string) => {
    const valid = new Set(['a1', 'a2', 'b', 'c1', 'c2', 'c3', 'd', 'e', 'f', 'standalone'])
    return valid.has(input) ? input : undefined
  },
}))

vi.mock('../../shared/adapters/github-infra', () => ({
  syncPriorityLabel: vi.fn(),
  syncSizeLabel: vi.fn(),
  syncLaneLabel: vi.fn(),
}))

vi.mock('../../shared/adapters/github-adapter', () => ({
  getItemId: vi.fn(),
  getNodeId: vi.fn(),
  getParentNumber: vi.fn(),
  updateField: vi.fn(),
  addBlockedBy: vi.fn(),
  removeBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
  removeSubIssue: vi.fn(),
  resolveIssueTypeId: vi.fn(),
  updateIssueIssueType: vi.fn(),
}))

const github = await import('../../shared/adapters/github-adapter')
const mockGetItemId = github.getItemId as ReturnType<typeof vi.fn>
const mockGetNodeId = github.getNodeId as ReturnType<typeof vi.fn>
const mockUpdateField = github.updateField as ReturnType<typeof vi.fn>
const mockAddBlockedBy = github.addBlockedBy as ReturnType<typeof vi.fn>
const mockRemoveBlockedBy = github.removeBlockedBy as ReturnType<typeof vi.fn>
const mockAddSubIssue = github.addSubIssue as ReturnType<typeof vi.fn>
const mockRemoveSubIssue = github.removeSubIssue as ReturnType<typeof vi.fn>
const mockGetParentNumber = github.getParentNumber as ReturnType<typeof vi.fn>
const mockResolveIssueTypeId = github.resolveIssueTypeId as ReturnType<typeof vi.fn>
const mockUpdateIssueIssueType = github.updateIssueIssueType as ReturnType<typeof vi.fn>

const githubInfra = await import('../../shared/adapters/github-infra')
const mockSyncPriorityLabel = githubInfra.syncPriorityLabel as ReturnType<typeof vi.fn>
const mockSyncSizeLabel = githubInfra.syncSizeLabel as ReturnType<typeof vi.fn>
const mockSyncLaneLabel = githubInfra.syncLaneLabel as ReturnType<typeof vi.fn>

const { setIssue } = await import('../lib/set')

function setupMocks() {
  vi.clearAllMocks()
  mockGetItemId.mockResolvedValue('item-123')
  mockGetNodeId.mockImplementation(async (num) => `node-${num}`)
  mockResolveIssueTypeId.mockResolvedValue('type-id-feat')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('issue-triage/set > field updates', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('updates size via label', async () => {
    await setIssue(['42', '--size', 'F-lite'])
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(42, 'F-lite')
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
    expect(mockGetNodeId).toHaveBeenCalledWith(100, undefined)
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

  it('adds cross-repo blocked-by dependency', async () => {
    await setIssue(['42', '--blocked-by', 'Roxabi/lyra#728'])
    expect(mockGetNodeId).toHaveBeenCalledWith(728, 'Roxabi/lyra')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-42', 'node-728')
  })

  it('adds cross-repo blocks dependency', async () => {
    await setIssue(['42', '--blocks', 'Roxabi/voiceCLI#94'])
    expect(mockGetNodeId).toHaveBeenCalledWith(94, 'Roxabi/voiceCLI')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-94', 'node-42')
  })

  it('handles mixed local and cross-repo refs', async () => {
    await setIssue(['42', '--blocked-by', '100, Roxabi/lyra#728, #101'])
    expect(mockGetNodeId).toHaveBeenCalledWith(100, undefined)
    expect(mockGetNodeId).toHaveBeenCalledWith(728, 'Roxabi/lyra')
    expect(mockGetNodeId).toHaveBeenCalledWith(101, undefined)
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(3)
  })
})

describe('issue-triage/set > parent-child relationships', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('sets parent relationship', async () => {
    await setIssue(['42', '--parent', '10'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-10', 'node-42')
  })

  it('sets cross-repo parent relationship', async () => {
    await setIssue(['42', '--parent', 'Roxabi/lyra#100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(100, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-100', 'node-42')
  })

  it('adds children', async () => {
    await setIssue(['42', '--add-child', '50,51'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-50')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-51')
  })

  it('adds cross-repo children', async () => {
    await setIssue(['42', '--add-child', 'Roxabi/lyra#50'])
    expect(mockGetNodeId).toHaveBeenCalledWith(50, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-50')
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
    await setIssue(['42', '--size', 'F-full', '--priority', 'Urgent', '--blocked-by', '99'])
    // size via label, priority via field + label
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(42, 'F-full')
    expect(mockUpdateField).toHaveBeenCalledTimes(1) // priority only
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(1)
  })

  it('strips # prefix from issue numbers', async () => {
    await setIssue(['42', '--blocked-by', '#100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(100, undefined)
  })
})

describe('issue-triage/set > priority label sync', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('syncs priority label when --priority is provided', async () => {
    await setIssue(['42', '--priority', 'Medium'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(42, 'P2 - Medium')
  })

  it('does not sync priority label when --priority is not provided', async () => {
    await setIssue(['42', '--size', 'F-lite'])
    expect(mockSyncPriorityLabel).not.toHaveBeenCalled()
  })
})

describe('issue-triage/set > --lane flag', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('updates lane via label', async () => {
    await setIssue(['123', '--lane', 'c1'])
    expect(mockSyncLaneLabel).toHaveBeenCalledWith(123, 'c1')
  })

  it('does nothing for invalid lane key (resolveLane returns undefined)', async () => {
    await setIssue(['123', '--lane', 'zzz'])
    expect(mockSyncLaneLabel).not.toHaveBeenCalled()
  })
})

describe('issue-triage/set > --type flag', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('resolves type id and calls updateIssueIssueType for valid type', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    // Act
    await setIssue(['123', '--type', 'feat'])
    // Assert
    expect(mockResolveIssueTypeId).toHaveBeenCalledWith('Test', 'feat')
    expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-123', 'type-id-feat')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('calls process.exit(1) and prints error for invalid type', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    // Act
    await setIssue(['123', '--type', 'bogus'])
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(errCalls.some((msg) => msg.includes('Invalid type') || msg.includes('Valid'))).toBe(true)
  })
})

describe('issue-triage/set > additive regression', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('--size alone does not call lane or type mutations', async () => {
    await setIssue(['123', '--size', 'S'])
    // size via label sync
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(123, 'S')
    expect(mockSyncLaneLabel).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })
})

describe('issue-triage/set > combined --lane + --type + --size', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('applies all three mutations when combined flags provided', async () => {
    await setIssue(['123', '--lane', 'a1', '--type', 'feat', '--size', 'S'])
    // Assert — size label
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(123, 'S')
    // Assert — lane label
    expect(mockSyncLaneLabel).toHaveBeenCalledWith(123, 'a1')
    // Assert — type mutation
    expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-123', 'type-id-feat')
  })
})
