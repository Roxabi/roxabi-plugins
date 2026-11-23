import { afterEach, describe, expect, it, vi } from 'vitest'
import * as github from '../../roxabi/feature-engine.ts'
import type { UwOperations } from '../../roxabi/uw-contract.ts'
import * as checkout from '../../roxabi/workflow-checkout.ts'
import { normalizationHandoffFixture } from '../../testing/normalization-handoff-fixture.ts'
import * as hostOperations from '../host-uw-operations.ts'
import { commandComposition } from './feature-command-fixture.ts'

afterEach(() => vi.restoreAllMocks())

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
  const git: checkout.GitRunner = async (_cwd, args) => {
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
  vi.spyOn(checkout, 'defaultGit').mockReturnValue(git)
  vi.spyOn(github, 'defaultGh').mockReturnValue(native.gh)
  // The missing-UW case exercises the admission fallback before any checkout work.
  if (missing === 'read') vi.spyOn(hostOperations, 'resolveFeatureUw').mockResolvedValue(undefined as never)
  const command = commandComposition(cwd, {
    principalCwd: () => cwd === principal,
    uwOperations: () => read as UwOperations,
  })
  return { native, calls, ...command }
}

describe('initial issue framing before checkout', () => {
  it.each([principal, other, intended])(
    'keeps the same unframed issue in framing from %s without preparing delivery',
    async (cwd) => {
      const subject = selection(cwd)
      await subject.run('#910')
      expect(subject.framing).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        { kind: 'issue', uw: { repository: 'fixture/widgets', target: 'fixture/widgets#910' } },
        expect.any(Function),
      )
      expect(subject.sent).toEqual([])
      expect(subject.calls.every((args) => args[0] === 'rev-parse' || args[0] === 'worktree')).toBe(true)
      expect(subject.native.rejected).toEqual([])
    },
  )

  it.each([
    { missing: 'read' as const, reason: 'uw-read-required' },
    { missing: 'root' as const, reason: 'graph-root-missing' },
  ])('preserves $reason instead of treating missing native facts as a fresh interview', async ({ missing, reason }) => {
    const subject = selection(principal, missing)
    await subject.run('#910')
    expect(subject.framing).not.toHaveBeenCalled()
    expect(subject.sent).toEqual([expect.stringContaining(reason)])
    expect(subject.native.rejected).toEqual([])
  })
})
