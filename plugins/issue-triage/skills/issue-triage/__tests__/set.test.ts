import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ConfigHelpers from '../../shared/adapters/config-helpers'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'

// Provide base project config for tests
process.env.GITHUB_REPO = 'Test/test-repo'

// Only GITHUB_REPO is stubbed. The resolvers are pure and are the contract under
// test: re-implementing them in a factory let the suite stay green while the real
// `resolvePriority` regressed (PR #528 review). `vitest.config.ts` sets
// `env.GITHUB_REPO`, so importing the real module is safe despite the hoist.
vi.mock('../../shared/adapters/config-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigHelpers>()),
  GITHUB_REPO: 'Test/test-repo',
}))

vi.mock('../../shared/adapters/github-infra', () => ({
  syncPriorityLabel: vi.fn(async () => true),
  syncSizeLabel: vi.fn(async () => true),
  syncLaneLabel: vi.fn(async () => true),
  syncStatusLabel: vi.fn(async () => true),
}))

vi.mock('../../shared/adapters/github-adapter', () => ({
  getNodeId: vi.fn(),
  getParentNumber: vi.fn(),
  addBlockedBy: vi.fn(),
  removeBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
  removeSubIssue: vi.fn(),
  resolveIssueTypeId: vi.fn(),
  updateIssueIssueType: vi.fn(),
}))

const github = await import('../../shared/adapters/github-adapter')
const mockGetNodeId = github.getNodeId as ReturnType<typeof vi.fn>
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
const mockSyncStatusLabel = githubInfra.syncStatusLabel as ReturnType<typeof vi.fn>

const { setIssue } = await import('../lib/set')

function setupMocks() {
  vi.clearAllMocks()
  // repo included in key so cross-repo calls return distinguishable node IDs
  mockGetNodeId.mockImplementation(async (num, repo?: string) =>
    repo ? `node-${repo.replace('/', '-')}-${num}` : `node-${num}`,
  )
  mockResolveIssueTypeId.mockResolvedValue('type-id-feat')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // console.error spy installed here — .mock.calls still accessible when impl is () => {}
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('issue-triage/set > field updates', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('updates size via label', async () => {
    await setIssue(['42', '--size', 'F-lite'])
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(42, 'F-lite')
  })

  it('updates priority via label with alias', async () => {
    await setIssue(['42', '--priority', 'High'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(42, 'P1 - High')
  })

  it('exits 1 on --status (issues-only model)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    await setIssue(['42', '--status', 'In Progress']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockSyncStatusLabel).not.toHaveBeenCalled()
  })

  it('exits with error for invalid --size value', async () => {
    // Arrange — throw on exit so execution stops after the guard, matching real process.exit semantics
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    // Act
    await setIssue(['42', '--size', 'bogus']).catch(() => {})
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(errCalls.some((m) => m.includes('Invalid size'))).toBe(true)
  })

  it('exits with error for invalid --priority value', async () => {
    // Arrange — throw on exit so execution stops after the guard, matching real process.exit semantics
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await setIssue(['42', '--priority', 'P3-nope']).catch(() => {})
    // Assert — an unrecognised value must not pass for a write that never happened
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockSyncPriorityLabel).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('Invalid priority'))).toBe(true)
  })

  it('echoes the canonical priority on a successful write', async () => {
    // Arrange
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])))
    // Act
    await setIssue(['42', '--priority', 'Medium'])
    // Assert
    expect(logs).toContain('Priority=P2 - Medium #42')
  })

  it('accepts the label spelling the CLI itself writes', async () => {
    // #525's own reproduction: `P3-low` is what `gh issue view` displays.
    await setIssue(['42', '--priority', 'P3-low'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(42, 'P3 - Low')
  })

  it('folds case on a lane key instead of rejecting it', async () => {
    await setIssue(['42', '--lane', 'A1'])
    expect(mockSyncLaneLabel).toHaveBeenCalledWith(42, 'a1')
  })

  it('exits 1 when a flag is given no value', async () => {
    // Arrange — `--priority "$P"` with an unset variable used to skip every guard
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await setIssue(['42', '--priority', '']).catch(() => {})
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockSyncPriorityLabel).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('--priority requires a value'))).toBe(true)
  })

  it('still links the parent when a label write fails, then exits 1', async () => {
    // Arrange — a repo without the lane label makes syncLaneLabel return false
    mockSyncLaneLabel.mockResolvedValueOnce(false)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    // Act
    await setIssue(['42', '--lane', 'b', '--parent', '7']).catch(() => {})
    // Assert — the relationship queued behind the label must not be cancelled
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-7', 'node-42')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('logs Size= exactly once for --size (no duplicate)', async () => {
    // Arrange
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])))
    // Act
    await setIssue(['42', '--size', 'F-lite'])
    // Assert
    expect(logs.filter((l) => l.startsWith('Size=')).length).toBe(1)
  })
})

describe('issue-triage/set > dependencies', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('adds blocked-by dependency', async () => {
    await setIssue(['42', '--blocked-by', '100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(42, undefined)
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
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-42', 'node-Roxabi-lyra-728')
  })

  it('adds cross-repo blocks dependency', async () => {
    await setIssue(['42', '--blocks', 'Roxabi/voiceCLI#94'])
    expect(mockGetNodeId).toHaveBeenCalledWith(94, 'Roxabi/voiceCLI')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-Roxabi-voiceCLI-94', 'node-42')
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
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-Roxabi-lyra-100', 'node-42')
  })

  it('adds children', async () => {
    await setIssue(['42', '--add-child', '50,51'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-50')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-51')
  })

  it('adds cross-repo children', async () => {
    await setIssue(['42', '--add-child', 'Roxabi/lyra#50'])
    expect(mockGetNodeId).toHaveBeenCalledWith(50, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-42', 'node-Roxabi-lyra-50')
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
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(42, 'F-full')
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(42, 'P0 - Urgent')
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

  it('exits with error for an invalid lane key', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await setIssue(['123', '--lane', 'zzz']).catch(() => {})
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockSyncLaneLabel).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('Invalid lane'))).toBe(true)
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

  it('writes nothing at all when the type is invalid', async () => {
    // Arrange — a throwing stub, because a no-op process.exit lets execution
    // continue past the guard and the test then passes on either ordering.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act — a parent is queued behind the bad type
    await setIssue(['123', '--type', 'bogus', '--parent', '7']).catch(() => {})
    // Assert — the priced quantity is "nothing was written", not "it printed"
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockResolveIssueTypeId).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
    expect(mockAddSubIssue).not.toHaveBeenCalled()
    expect(errors.some((msg) => msg.includes('Invalid type'))).toBe(true)
  })
})

describe('issue-triage/set > cross-repo subject', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('resolves cross-repo subject for --blocked-by', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--blocked-by', 'Roxabi/lyra#1063,Roxabi/lyra#1064'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(1063, 'Roxabi/lyra')
    expect(mockGetNodeId).toHaveBeenCalledWith(1064, 'Roxabi/lyra')
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(2)
  })

  it('resolves cross-repo subject for --blocks', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--blocks', 'Roxabi/lyra#200'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(200, 'Roxabi/lyra')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-Roxabi-lyra-200', 'node-Roxabi-voiceCLI-144')
  })

  it('resolves cross-repo subject for --parent', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--parent', 'Roxabi/lyra#10'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(10, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-Roxabi-lyra-10', 'node-Roxabi-voiceCLI-144')
  })

  it('rejects an unrecognised value even when the label write is skipped', async () => {
    // Arrange — skipping the write used to skip the guard, so #525's silent
    // success survived on the cross-repo path (PR #528 review).
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await setIssue(['Roxabi/lyra#144', '--priority', 'totally-bogus', '--parent', '#7']).catch(() => {})
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockAddSubIssue).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('Invalid priority'))).toBe(true)
  })

  it('resolves cross-repo subject for --add-child', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--add-child', 'Roxabi/lyra#50'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(50, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-Roxabi-voiceCLI-144', 'node-Roxabi-lyra-50')
  })

  it('exits 1 on --status for cross-repo subject too', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    await setIssue(['Roxabi/voiceCLI#144', '--status', 'Backlog']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockSyncStatusLabel).not.toHaveBeenCalled()
  })

  it('skips label sync for cross-repo subject with --size', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--size', 'S'])
    expect(mockSyncSizeLabel).not.toHaveBeenCalled()
    const errCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(errCalls.some((m) => m.includes('label sync') && m.includes('cross-repo'))).toBe(true)
  })

  it('exits with error for --rm-parent on cross-repo subject', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    await setIssue(['Roxabi/voiceCLI#144', '--rm-parent'])
    expect(exitSpy).toHaveBeenCalledWith(1)
    const errCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(errCalls.some((m) => m.includes('--rm-parent') && m.includes('cross-repo'))).toBe(true)
  })

  it('log output shows cross-repo subject correctly', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(String(args[0])))
    await setIssue(['Roxabi/voiceCLI#144', '--blocked-by', '100'])
    expect(logs.some((l) => l.includes('Roxabi/voiceCLI#144'))).toBe(true)
    expect(logs.some((l) => l.includes('#100'))).toBe(true)
  })

  it('removes blocked-by with cross-repo subject', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--rm-blocked-by', 'Roxabi/lyra#1063'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(1063, 'Roxabi/lyra')
    expect(mockRemoveBlockedBy).toHaveBeenCalledWith('node-Roxabi-voiceCLI-144', 'node-Roxabi-lyra-1063')
  })

  it('removes blocks with cross-repo subject', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--rm-blocks', 'Roxabi/lyra#200'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(200, 'Roxabi/lyra')
    expect(mockRemoveBlockedBy).toHaveBeenCalledWith('node-Roxabi-lyra-200', 'node-Roxabi-voiceCLI-144')
  })

  it('removes child with cross-repo subject', async () => {
    await setIssue(['Roxabi/voiceCLI#144', '--rm-child', 'Roxabi/lyra#50'])
    expect(mockGetNodeId).toHaveBeenCalledWith(144, 'Roxabi/voiceCLI')
    expect(mockGetNodeId).toHaveBeenCalledWith(50, 'Roxabi/lyra')
    expect(mockRemoveSubIssue).toHaveBeenCalledWith('node-Roxabi-voiceCLI-144', 'node-Roxabi-lyra-50')
  })
})

describe('issue-triage/set > additive regression', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('--size alone does not call lane or type mutations', async () => {
    await setIssue(['123', '--size', 'S'])
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(123, 'S')
    expect(mockSyncLaneLabel).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })
})

describe('issue-triage/set > applyType accepts all 10 canonical values', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  const ALL_VALID_TYPES = [...ISSUE_TYPE_NAMES, ...EXTENDED_ISSUE_TYPES]

  it('accepts every value in the canonical set without calling process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    for (const t of ALL_VALID_TYPES) {
      vi.clearAllMocks()
      mockGetNodeId.mockResolvedValue(`node-123`)
      mockResolveIssueTypeId.mockResolvedValue(`type-id-${t}`)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await setIssue(['123', '--type', t])
      expect(exitSpy).not.toHaveBeenCalled()
      expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-123', `type-id-${t}`)
    }
  })

  it('rejects an unknown type before any write', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    await setIssue(['123', '--type', 'unknown-type']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('Invalid type'))).toBe(true)
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
