import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/adapters/github-infra', () => ({
  PROTECTED_BRANCHES: ['main', 'staging'],
  buildBranchProtectionPayload: vi.fn(() => ({
    required_status_checks: { strict: true, contexts: ['ci'] },
    enforce_admins: false,
    restrictions: null,
  })),
  detectSecretScanWorkflow: vi.fn(async () => false),
  DEFAULT_RULESET: {
    name: 'PR_Main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: {} }],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
  },
}))

vi.mock('../../shared/adapters/github-adapter', () => ({
  run: vi.fn(),
}))

describe('protectBranches', () => {
  let mockRun: ReturnType<typeof vi.fn>
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const github = await import('../../shared/adapters/github-adapter')
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

    expect(result.branches.main).toBe(true)
    expect(result.branches.staging).toBe(true)
    expect(result.ruleset).toBe(true)
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
    const _result = await protectBranches('Org/repo')

    // run() should have been called for git branch + git push for each branch
    expect(mockRun).toHaveBeenCalled()
    const branchCalls = mockRun.mock.calls.filter((c: string[][]) => c[0].includes('git'))
    expect(branchCalls.length).toBeGreaterThan(0)
  })

  it('deletes PR review requirement after applying protection', async () => {
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    spawnSpy.mockReturnValue({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    } as unknown as ReturnType<typeof Bun.spawn>)

    const { protectBranches } = await import('../lib/protection')
    await protectBranches('Org/repo')

    // 2 calls per branch: PUT protection + DELETE required_pull_request_reviews
    // + 1 list rulesets + 1 create ruleset = more spawn calls
    const spawnCalls = spawnSpy.mock.calls
    const deleteCalls = spawnCalls.filter((c: unknown[]) => {
      const args = c[0] as string[]
      return args.includes('-X') && args.includes('DELETE')
    })
    expect(deleteCalls.length).toBe(2) // one per protected branch
  })

  it('returns false for branches when protection API fails', async () => {
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

    expect(result.branches.main).toBe(false)
    expect(result.branches.staging).toBe(false)
  })

  it('passes hasSecretScan: true to buildBranchProtectionPayload when secret-scan.yml is present', async () => {
    const { detectSecretScanWorkflow, buildBranchProtectionPayload } = await import(
      '../../shared/adapters/github-infra'
    )

    ;(detectSecretScanWorkflow as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true)

    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    spawnSpy.mockReturnValue({
      exited: Promise.resolve(0),
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
    } as unknown as ReturnType<typeof Bun.spawn>)

    const { protectBranches } = await import('../lib/protection')
    await protectBranches('Org/repo')

    expect(buildBranchProtectionPayload).toHaveBeenCalledTimes(2)
    expect(buildBranchProtectionPayload).toHaveBeenNthCalledWith(1, { hasSecretScan: true })
    expect(buildBranchProtectionPayload).toHaveBeenNthCalledWith(2, { hasSecretScan: true })
  })
})
