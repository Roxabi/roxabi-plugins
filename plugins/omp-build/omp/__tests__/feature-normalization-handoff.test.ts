import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry.ts'
import { continueFeature } from '../../roxabi/workflow.ts'
import type * as checkout from '../../roxabi/workflow-checkout.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { normalizationHandoffFixture } from '../../testing/normalization-handoff-fixture.ts'

vi.mock('../../roxabi/workflow-checkout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof checkout>()),
  runWorktreeBootstrap: vi.fn(async () => ({ ok: true as const })),
}))

import { runWorktreeBootstrap } from '../../roxabi/workflow-checkout.ts'

const principal = '/principal'
const intended = '/worktrees/feature-910'
const other = '/worktrees/other'
const branch = 'fix/910-principal-normalization-handoff'
const stack = JSON.stringify({ schema_version: '1.0', runtime: 'bun', release: { model: 'trunk' } })

function setup(options: { cwd?: string; failBase?: boolean; missingRead?: boolean; missingRoot?: boolean } = {}) {
  const cwd = options.cwd ?? principal
  const fixture = normalizationHandoffFixture()
  const calls: string[][] = []
  const attemptedWork: string[] = []
  const results: ContinueFeatureResult[] = []
  const messages: string[] = []
  let workflowCalls = 0
  const trees =
    `worktree ${principal}\nbranch refs/heads/main\n\n` +
    `worktree ${intended}\nbranch refs/heads/${branch}\n\n` +
    `worktree ${other}\nbranch refs/heads/other\n`
  const git: GitRunner = async (_cwd, args) => {
    calls.push([...args])
    if (args.join(' ') === 'rev-parse --show-toplevel') return { code: 0, stdout: cwd, stderr: '' }
    if (args.join(' ') === 'worktree list --porcelain') return { code: 0, stdout: trees, stderr: '' }
    if (args.join(' ') === 'show HEAD:.dev/stack.yml')
      return { code: options.failBase ? 1 : 0, stdout: stack, stderr: '' }
    if (args.join(' ') === 'symbolic-ref --short refs/remotes/origin/HEAD')
      return { code: 0, stdout: 'origin/main', stderr: '' }
    throw new Error(`Unexpected git operation: ${args.join(' ')}`)
  }
  const read = options.missingRead
    ? undefined
    : options.missingRoot
      ? {
          readUw: async (scope: Parameters<typeof fixture.read.readUw>[0]) => {
            const observed = await fixture.read.readUw(scope)
            return { ...observed, graph: { ...observed.graph, nodes: [] } }
          },
        }
      : fixture.read
  const workflow: FeatureWorkflow = {
    continueFeature: async (input) => {
      workflowCalls++
      const result = await continueFeature({ ...input, git, gh: fixture.gh, read })
      results.push(result)
      return result
    },
    consumeWatchExit: async () => {
      throw new Error('unexpected watch')
    },
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected publication')
    },
    requestFeatureSessionPause: async () => {
      throw new Error('unexpected pause')
    },
  }
  const forbidden = (name: string): never => {
    attemptedWork.push(name)
    throw new Error(`unexpected ${name}`)
  }
  const host: FeatureCommandHost = {
    key: {},
    cwd,
    principal: cwd === principal,
    workflow,
    native: {
      activate: () => forbidden('activate'),
      inactive: () => forbidden('inactive'),
      stopOwned: async () => forbidden('stop'),
      announce: async () => forbidden('announce'),
    },
    send: async (message) => {
      messages.push(message)
    },
    status: () => {},
    inhibitFeatureContinuation: () => {},
    releaseFeatureContinuation: () => {},
    featureContinuationInhibited: () => false,
    markFeatureBatch: () => forbidden('batch'),
    startReview: async () => forbidden('review'),
    startFix: async () => forbidden('fix'),
    startAdmittedCiCorrection: async () => forbidden('correction'),
    prepareEpicRangeReview: async () => forbidden('epic-review'),
    exec: async () => forbidden('exec'),
  }
  return { host, messages, results, calls, attemptedWork, fixture, workflowCalls: () => workflowCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The Node worker lacks Bun.YAML; JSON is a YAML-compatible stack document.
  vi.stubGlobal('Bun', {
    ...globalThis.Bun,
    YAML: {
      parse: (text: string) => {
        if (text !== stack) throw new Error('unexpected stack YAML fixture')
        return JSON.parse(text)
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('legacy UW normalization checkout handoff', () => {
  it.each([principal, other])('moves from %s to the intended linked checkout before work', async (cwd) => {
    const subject = setup({ cwd })
    await runInstalledFeatureCommand('#910', subject.host)
    expect(subject.messages).toEqual([`session-cwd ${intended}\n/move ${intended}`])
    expect(subject.results).toEqual([{ kind: 'session-cwd', path: intended, instruction: `/move ${intended}` }])
    expect(subject.workflowCalls()).toBe(1)
    expect(subject.attemptedWork).toEqual([])
    expect(vi.mocked(runWorktreeBootstrap)).not.toHaveBeenCalled()
    expect(subject.fixture.rejected).toEqual([])
  })

  it('exposes normalization only after preparing the matching checkout, without publishing', async () => {
    const subject = setup({ cwd: intended })
    await runInstalledFeatureCommand('#910', subject.host)
    expect(subject.results).toHaveLength(1)
    expect(subject.results[0]).toMatchObject({ kind: 'normalization' })
    expect(runWorktreeBootstrap).toHaveBeenCalledExactlyOnceWith(intended)
    expect(subject.messages).toEqual(['feature-stopped: prepare-action-unavailable'])
    expect(subject.attemptedWork).toEqual([])
    expect(subject.fixture.rejected).toEqual([])
    expect(subject.workflowCalls()).toBe(1)
  })

  it('does not normalize when checkout preparation fails', async () => {
    const subject = setup({ failBase: true })
    await runInstalledFeatureCommand('#910', subject.host)
    expect(subject.results).toEqual([{ kind: 'blocked', reason: 'base-unreadable' }])
    expect(subject.messages[0]).toContain('base-unreadable')
    expect(subject.attemptedWork).toEqual([])
  })

  it.each([
    { missingRead: true, reason: 'uw-read-required' },
    { missingRoot: true, reason: 'graph-root-missing' },
  ])('preserves $reason without preparing a checkout', async ({ reason, ...options }) => {
    const subject = setup(options)
    await runInstalledFeatureCommand('#910', subject.host)
    expect(subject.results).toEqual([{ kind: 'blocked', reason }])
    expect(subject.calls.some((args) => args[0] === 'show')).toBe(false)
    expect(runWorktreeBootstrap).not.toHaveBeenCalled()
  })

  it.each(['#910', 'resume #910', 'new #910'])(
    'still refuses a directly returned normalization on Principal for %s',
    async (command) => {
      const subject = setup()
      subject.host.workflow.continueFeature = async () =>
        ({ kind: 'normalization', request: {} }) as ContinueFeatureResult
      await runInstalledFeatureCommand(command, subject.host)
      expect(subject.messages).toEqual([
        'session-cwd /principal\nfeature-stopped: principal-dispatch-refused: workflow-result: normalization',
      ])
      expect(subject.attemptedWork).toEqual([])
    },
  )
})
