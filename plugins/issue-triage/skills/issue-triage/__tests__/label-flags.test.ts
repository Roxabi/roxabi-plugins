import { describe, expect, it, vi } from 'vitest'

process.env.GITHUB_REPO = 'Test/test-repo'

vi.mock('../../shared/adapters/github-infra', () => ({
  syncPriorityLabel: vi.fn(async () => false),
  syncSizeLabel: vi.fn(async () => false),
  syncLaneLabel: vi.fn(async () => false),
  syncStatusLabel: vi.fn(async () => false),
}))

// Dynamic: the module under test must load after vi.mock registers the stubs,
// which a hoisted static import would precede. Same shape as the sibling suites.
const { writeLabels } = await import('../lib/label-flags')

describe('issue-triage/label-flags > writeLabels', () => {
  it('collects every failed label instead of exiting on the first', async () => {
    // Every branch matters: the pre-fix code exited inside each one, so a
    // partial reintroduction on any single branch is the realistic regression
    // (PR #528 review). The `--lane` reproduction alone would not catch it.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const failed = await writeLabels(42, {
      priority: 'P3 - Low',
      size: 'S',
      lane: 'b',
      status: 'Backlog',
    })

    expect(failed).toEqual(['priority', 'size', 'lane', 'status'])
    expect(exitSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
