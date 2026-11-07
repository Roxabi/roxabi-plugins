import { describe, expect, it } from 'vitest'
import { continueFeature } from '../../roxabi/workflow.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { normalizationHandoffFixture } from '../../testing/normalization-handoff-fixture.ts'

const principal = '/principal'
const intended = '/worktrees/feature-910'
const other = '/worktrees/other'
const branch = 'fix/910-principal-normalization-handoff'

/** Only native repository observations are replaced; the workflow and UW reader are real. */
function selection(cwd: string, missing: 'read' | 'root' | null = null) {
  const native = normalizationHandoffFixture()
  const calls: string[][] = []
  const trees =
    `worktree ${principal}\nbranch refs/heads/main\n\n` +
    `worktree ${intended}\nbranch refs/heads/${branch}\n\n` +
    `worktree ${other}\nbranch refs/heads/other\n`
  const git: GitRunner = async (_cwd, args) => {
    calls.push([...args])
    if (args.join(' ') === 'rev-parse --show-toplevel') return { code: 0, stdout: cwd, stderr: '' }
    if (args.join(' ') === 'worktree list --porcelain') return { code: 0, stdout: trees, stderr: '' }
    throw new Error(`Initial framing must not prepare or bootstrap a checkout: ${args.join(' ')}`)
  }
  const read =
    missing === 'read'
      ? undefined
      : missing === 'root'
        ? {
            readUw: async (scope: Parameters<typeof native.read.readUw>[0]) => {
              const observed = await native.read.readUw(scope)
              return { ...observed, graph: { ...observed.graph, nodes: [] } }
            },
          }
        : native.read
  return {
    native,
    calls,
    run: () =>
      continueFeature({
        cwd,
        reference: '#910',
        control: 'select',
        principal: cwd === principal,
        git,
        gh: native.gh,
        read,
      }),
  }
}

describe('initial issue framing before checkout', () => {
  it.each([principal, other, intended])(
    'keeps the same unframed issue in framing from %s without preparing delivery',
    async (cwd) => {
      const subject = selection(cwd)
      const result = await subject.run()
      expect(result).toEqual({
        kind: 'framing',
        source: { kind: 'issue', uw: { repository: 'fixture/widgets', target: 'fixture/widgets#910' } },
      })
      expect(subject.calls.every((args) => args[0] === 'rev-parse' || args[0] === 'worktree')).toBe(true)
      expect(subject.native.rejected).toEqual([])
    },
  )

  it.each([
    { missing: 'read' as const, reason: 'uw-read-required' },
    { missing: 'root' as const, reason: 'graph-root-missing' },
  ])('preserves $reason instead of treating missing native facts as a fresh interview', async ({ missing, reason }) => {
    const subject = selection(principal, missing)
    expect(await subject.run()).toEqual({ kind: 'blocked', reason })
    expect(subject.native.rejected).toEqual([])
  })
})
