import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../shared/config', () => ({
  PROTECTED_BRANCHES: ['main', 'staging'],
  BRANCH_PROTECTION_PAYLOAD: {
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_status_checks: { strict: true, contexts: ['ci'] },
    enforce_admins: false,
    restrictions: null,
  },
}))

vi.mock('../../shared/github', () => ({
  run: vi.fn(),
}))

describe('protectBranches', () => {
  let mockRun: ReturnType<typeof vi.fn>
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    const github = await import('../../shared/github')
    mockRun = github.run as ReturnType<typeof vi.fn>
    mockRun.mockResolvedValue('')

    spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
    spawnSpy = vi.spyOn(Bun, 'spawn')
  })

  afterEach(() => {
    spawnSyncSpy.mockRestore()
    spawnSpy.mockRestore()
  })

  it('protects both main and staging branches', async () => {
    // Branch exists
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    // gh api succeeds
    spawnSpy.mockReturnValue({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    } as unknown as ReturnType<typeof Bun.spawn>)

    const { protectBranches } = await import('../lib/protection')
    const result = await protectBranches('Org/repo')

    expect(result.main).toBe(true)
    expect(result.staging).toBe(true)
  })

  it('creates branch if it does not exist', async () => {
    // Branch does not exist
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 1,
      success: false,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    spawnSpy.mockReturnValue({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    } as unknown as ReturnType<typeof Bun.spawn>)

    const { protectBranches } = await import('../lib/protection')
    const result = await protectBranches('Org/repo')

    // run() should have been called for git branch + git push for each branch
    expect(mockRun).toHaveBeenCalled()
    const branchCalls = mockRun.mock.calls.filter((c: string[][]) => c[0].includes('git'))
    expect(branchCalls.length).toBeGreaterThan(0)
  })

  it('returns false when protection API fails', async () => {
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    spawnSpy.mockReturnValue({
      exited: Promise.resolve(1),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    } as unknown as ReturnType<typeof Bun.spawn>)

    const { protectBranches } = await import('../lib/protection')
    const result = await protectBranches('Org/repo')

    expect(result.main).toBe(false)
    expect(result.staging).toBe(false)
  })
})
