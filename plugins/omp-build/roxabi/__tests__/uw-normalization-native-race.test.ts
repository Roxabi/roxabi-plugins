import type { ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import { afterEach, expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { NormalizationJudgement } from '../../engine/uw-normalization-schema.ts'
import type { NativeBatch, NativeBatchCallbacks } from '../../omp/review-runtime/contracts.ts'
import { bridgeHarness, root as nativeRoot } from '../../testing/review-runtime-support.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../feature-contract.ts'
import type { NormalizationProposalRequest, UwOperations } from '../uw-contract.ts'
import { announceUwNormalization } from '../uw-normalization-host.ts'
import {
  isolateViewerToken,
  observationalGh,
  observationalGit,
  preparedNormalization,
  releaseViewerToken,
} from './uw-normalization-observation.ts'

const request = {
  uw: { repository: 'acme/widgets', target: 'acme/widgets#42' },
  title: 'Normalize the current UW',
  parsed: parseIssueSpecBody({
    uw: { repository: 'acme/widgets', target: 'acme/widgets#42' },
    raw: rawSource('acme/widgets#42', '', null),
  }),
  graph: {} as never,
  writes: {} as never,
} as NormalizationProposalRequest

const judgement: NormalizationJudgement = {
  draft: {
    criteria: [{ kind: 'new', draftKey: 'criterion-1', statement: 'Preserves the current obligation' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  },
  normalization: [],
  factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
  tierOverride: null,
}

afterEach(() => releaseViewerToken())

it.each([
  ['baseline', 1, 1],
  ['session switch', 0, 0],
  ['inhibit only', 1, 0],
] as const)(
  '%s during result sealing writes %i and continues %i times',
  async (mode, expectedWrites, expectedContinuations) => {
    isolateViewerToken()
    const harness = bridgeHarness()
    const { controller, emitBridge } = harness
    const root = {
      ...nativeRoot,
      cwd: '/repo/feature',
      sessionManager: { getSessionId: () => 'normalization-root' },
    }
    await emitBridge('session_start', { type: 'session_start' }, root)
    const writes: unknown[] = []
    const continuations: unknown[] = []
    const failure = Promise.withResolvers<never>()
    void failure.promise.catch(() => undefined)
    const sealEntered = Promise.withResolvers<void>()
    const releaseSeal = Promise.withResolvers<void>()
    const inner = observationalGh()
    let posts = 0
    const gh: Gh = async (cwd, args) => {
      if (args.includes('--method') && args.includes('POST') && args.join(' ').includes('/comments')) {
        posts += 1
        if (posts === 2) {
          sealEntered.resolve()
          await releaseSeal.promise
        }
      }
      return inner(cwd, args)
    }
    const unexpected = async (): Promise<never> => {
      throw new Error('unexpected UW operation')
    }
    const operations: UwOperations = {
      readUw: unexpected,
      prepare: unexpected,
      validateNormalization: () => ({ ok: true, value: judgement }),
      write: async (input) => {
        writes.push(input)
        return { status: 'written', value: {} as never }
      },
      create: unexpected,
      acceptMaterial: unexpected,
      prepareAction: async () => ({ ok: true, value: preparedNormalization(request, true) }),
      prepareReviewActions: unexpected,
      replayActionInputs: unexpected,
      verifyAction: unexpected,
      readDelivery: unexpected,
    }
    const workflow = {
      continueFeature: async (input: unknown) => {
        continuations.push(input)
        return { kind: 'terminal' as const, reason: 'continued-after-normalization' }
      },
    } as FeatureWorkflow
    let batch: NativeBatch | undefined
    const host = {
      key: {},
      cwd: '/repo/feature',
      principal: false,
      workflow,
      uw: operations,
      native: {
        activate: (next: NativeBatch, callbacks: NativeBatchCallbacks) => {
          batch = next
          controller.activate(next, callbacks)
        },
        inactive: () => controller.inactive(),
        stopOwned: (owned: NativeBatch, reason: string) => controller.stopOwned(owned, reason),
        announce: async (owned: NativeBatch) => {
          if (!controller.announce(owned)) throw new Error('normalization batch was not announced')
        },
      },
      send: async () => undefined,
      inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
      releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
      featureContinuationInhibited: () => controller.featureContinuationInhibited(),
      markFeatureBatch: () => undefined,
      exec: async () => ({ code: 0, killed: false }),
    } as FeatureCommandHost
    await announceUwNormalization({
      reference: 'acme/widgets#42',
      request,
      original: {
        cwd: '/repo/feature',
        reference: 'acme/widgets#42',
        control: 'select',
        principal: false,
        git: observationalGit(),
        gh,
      },
      host,
      deliver: async (result: ContinueFeatureResult) => {
        if (result.kind === 'blocked' && mode !== 'session switch')
          failure.reject(new Error(`normalization blocked: ${result.reason}`))
      },
    })
    if (batch === undefined) throw new Error('normalization batch was not activated')
    const input = controller.wire(batch)
    if (input === null) throw new Error('normalization wire input was not available')
    const task = batch.tasks.tasks[0]
    if (task === undefined) throw new Error('normalization task was not available')
    await harness.admitChild(batch, task.name, 'R-uw-normalize', { toolCallId: 'task-call', root })
    await harness.yieldChild('R-uw-normalize', judgement, { toolCallId: 'yield-1' })
    const result: ToolResultEvent = {
      type: 'tool_result',
      toolName: 'task',
      input,
      toolCallId: 'task-call',
      isError: false,
      content: [],
      details: {
        results: [
          {
            id: 'R-uw-normalize',
            index: 0,
            agent: 'R-uw-normalize',
            exitCode: 0,
            structuredOutput: { status: 'valid', data: judgement },
          },
        ],
      },
    }
    const settled = controller.receiveResult(result)
    let settlementFinished = false
    void settled.then(
      () => {
        settlementFinished = true
      },
      () => {
        settlementFinished = true
      },
    )
    void settled.catch(failure.reject)
    try {
      await Promise.race([sealEntered.promise, failure.promise])
      expect(settlementFinished).toBe(false)
      if (mode !== 'baseline') controller.inhibitFeatureContinuation()
      const switching = mode === 'session switch' ? emitBridge('session_switch', {}, root) : Promise.resolve()
      releaseSeal.resolve()
      await Promise.race([Promise.all([settled, switching]), failure.promise])
      expect(writes).toHaveLength(expectedWrites)
      expect(continuations).toHaveLength(expectedContinuations)
    } finally {
      releaseSeal.resolve()
    }
  },
)
