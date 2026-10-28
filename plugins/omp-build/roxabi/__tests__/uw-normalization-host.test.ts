import { describe, expect, it, vi } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import type { NormalizationJudgement } from '../../engine/uw-normalization-schema.ts'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../feature-contract.ts'
import type { NormalizationProposalRequest, UwOperations } from '../uw-contract.ts'
import { announceUwNormalization } from '../uw-normalization-host.ts'
import {
  bindHistoricalProjection,
  bindSuccessorWriter,
  markSuccessorNormalization,
} from '../uw-normalization-internal.ts'

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

function settled(batch: NativeBatch): NativeBatchResult {
  return {
    batch,
    complete: true,
    raw: null,
    children: [
      {
        id: 'native-normalization',
        expectedId: 'R-uw-normalize',
        submissions: [],
        proofEvidence: null,
        raw: null,
        partialText: null,
        structured: judgement,
        usable: true,
        reason: null,
      },
    ],
  }
}

function fixture(control: 'select' | 'new' = 'select', eligible = false) {
  let callbacks: NativeBatchCallbacks | undefined
  let activeBatch: NativeBatch | undefined
  let inhibited = false
  const writes: unknown[] = []
  const sent: string[] = []
  const continued: unknown[] = []
  const delivered: ContinueFeatureResult[] = []
  let deliver: (result: ContinueFeatureResult) => Promise<void> = async (result) => {
    delivered.push(result)
  }
  const operations: UwOperations = {
    readUw: async () => {
      throw new Error('unexpected readUw')
    },
    prepare: async () => {
      throw new Error('unexpected prepare')
    },
    validateNormalization: () => ({ ok: true, value: judgement }),
    write: async (input) => {
      writes.push(input)
      return { status: 'written', value: {} as never }
    },
    create: async () => {
      throw new Error('unexpected create')
    },
    acceptMaterial: async () => {
      throw new Error('unexpected acceptMaterial')
    },
  }
  if (eligible) {
    const read = {} as never
    bindHistoricalProjection(read, {} as never, 'history')
    markSuccessorNormalization(request, read)
    bindSuccessorWriter(operations, async (input) => operations.write(input))
  }
  const workflow = {
    continueFeature: async (input: unknown) => {
      continued.push(input)
      return { kind: 'terminal' as const, reason: 'continued-after-normalization' }
    },
  } as FeatureWorkflow
  const host = {
    key: {},
    cwd: '/repo/feature',
    principal: false,
    workflow,
    uw: operations,
    native: {
      activate: (batch: NativeBatch, value: NativeBatchCallbacks) => {
        activeBatch = batch
        callbacks = value
      },
      inactive: () => undefined,
      stopOwned: async () => undefined,
      announce: async () => undefined,
    },
    send: async (text: string) => {
      sent.push(text)
    },
    inhibitFeatureContinuation: () => {
      inhibited = true
    },
    releaseFeatureContinuation: () => {
      inhibited = false
    },
    featureContinuationInhibited: () => inhibited,
    markFeatureBatch: () => undefined,
    exec: async () => ({ code: 0, killed: false }),
  } as FeatureCommandHost
  const announce = () =>
    announceUwNormalization({
      reference: 'acme/widgets#42',
      request,
      original: { cwd: '/repo/feature', reference: 'acme/widgets#42', control, principal: false },
      host,
      deliver: (result) => deliver(result),
    })
  const currentBatch = (): NativeBatch => {
    if (activeBatch === undefined) throw new Error('normalization batch was not activated')
    return activeBatch
  }
  const complete = () => callbacks?.onComplete(settled(currentBatch()))
  const settle = () => callbacks?.onSettled?.(settled(currentBatch()))
  const stop = (reason: string) => callbacks?.onStop(reason, settled(currentBatch()))
  return {
    operations,
    workflow,
    announce,
    complete,
    settle,
    stop,
    writes,
    sent,
    continued,
    delivered,
    setDeliver: (value: (result: ContinueFeatureResult) => Promise<void>) => {
      deliver = value
    },
    inhibit: () => {
      inhibited = true
    },
  }
}

function diagnostic(code: string): UwDiagnostic {
  return {
    code,
    message: `${code} observed`,
    location: { kind: 'native', uw: request.uw, connection: 'state' },
    related: [],
  }
}

describe('UW normalization native lifecycle', () => {
  it('retains explicit new only for an eligible live normalization', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture('new', true)
      await subject.announce()
      subject.complete()
      subject.settle()
      await vi.runAllTimersAsync()
      expect(subject.writes).toHaveLength(1)
      expect(subject.continued).toEqual([expect.objectContaining({ control: 'new' })])
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses forged explicit new intent without a selection capability', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture('new')
      await subject.announce()
      subject.complete()
      subject.settle()
      await vi.runAllTimersAsync()
      expect(subject.writes).toEqual([])
      expect(subject.continued).toEqual([])
      expect(subject.delivered).toContainEqual(expect.objectContaining({ reason: 'uw-normalization-ineligible' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps effects unresolved when native completion returns and starts them only after settlement', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()

      await subject.announce()
      await subject.complete()

      expect(subject.writes).toEqual([])
      expect(subject.continued).toEqual([])
      expect(subject.delivered).toEqual([])

      await subject.settle()
      expect(subject.writes).toEqual([])

      await vi.runAllTimersAsync()

      expect(subject.writes).toHaveLength(1)
      expect(subject.continued).toHaveLength(1)
      expect(subject.delivered).toEqual([{ kind: 'terminal', reason: 'continued-after-normalization' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops native work stopped by a session switch before it can publish or continue', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()

      await subject.announce()
      await subject.stop('session-switch')
      await vi.runAllTimersAsync()

      expect(subject.writes).toEqual([])
      expect(subject.continued).toEqual([])
      expect(subject.delivered).toContainEqual(
        expect.objectContaining({ kind: 'blocked', reason: 'normalization-session-switch' }),
      )
      expect(subject.sent).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not publish or continue when continuation becomes inhibited while the native batch settles', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()

      await subject.announce()
      await subject.complete()
      subject.inhibit()
      await subject.settle()
      await vi.runAllTimersAsync()

      expect(subject.writes).toEqual([])
      expect(subject.continued).toEqual([])
      expect(subject.delivered).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it('delivers every malformed native obligation with native child ID references', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()
      subject.operations.validateNormalization = () => ({
        ok: false,
        diagnostics: [
          diagnostic('normalization-source-unaccounted'),
          diagnostic('normalization-target-duplicate'),
          diagnostic('normalization-preserved-unaccounted'),
        ],
      })

      await subject.announce()
      await subject.complete()
      await subject.settle()
      await vi.runAllTimersAsync()

      expect(subject.writes).toEqual([])
      expect(subject.continued).toEqual([])
      const blocker = subject.delivered[0]
      expect(blocker?.kind).toBe('blocked')
      if (blocker?.kind === 'blocked') {
        expect(blocker.diagnostics?.map((item) => item.code)).toEqual([
          'normalization-source-unaccounted',
          'normalization-target-duplicate',
          'normalization-preserved-unaccounted',
          'normalization-native-result',
        ])
        expect(blocker.diagnostics?.at(-1)).toMatchObject({
          operationId: expect.stringMatching(/^uw-normalize:/),
          detail: { native: { complete: true, childIds: ['native-normalization'] } },
        })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers every refusal diagnostic without continuing', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()
      subject.operations.write = async () => ({
        status: 'refused',
        diagnostics: [diagnostic('operator-refused'), diagnostic('proposal-stale')],
      })

      await subject.announce()
      await subject.complete()
      await subject.settle()
      await vi.runAllTimersAsync()

      expect(subject.continued).toEqual([])
      expect(subject.delivered).toContainEqual(
        expect.objectContaining({
          kind: 'blocked',
          reason: 'uw-normalization-refused',
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'operator-refused' }),
            expect.objectContaining({ code: 'proposal-stale' }),
            expect.objectContaining({ code: 'normalization-native-result' }),
          ]),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a stopped result when deferred write or continuation fails', async () => {
    vi.useFakeTimers()
    try {
      const writeFailure = fixture()
      writeFailure.operations.write = async () => {
        throw new Error('native-write-read-failed')
      }

      await writeFailure.announce()
      await writeFailure.complete()
      await writeFailure.settle()
      await vi.runAllTimersAsync()

      expect(writeFailure.continued).toEqual([])
      expect(writeFailure.delivered).toContainEqual(
        expect.objectContaining({ kind: 'blocked', reason: 'native-write-read-failed' }),
      )

      const continuationFailure = fixture()
      continuationFailure.workflow.continueFeature = async () => {
        throw new Error('feature-continuation-failed')
      }

      await continuationFailure.announce()
      await continuationFailure.complete()
      await continuationFailure.settle()
      await vi.runAllTimersAsync()

      expect(continuationFailure.delivered).toContainEqual(
        expect.objectContaining({ kind: 'blocked', reason: 'feature-continuation-failed' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
  it('reports a deferred delivery rejection through the host stop channel with native references', async () => {
    vi.useFakeTimers()
    try {
      const subject = fixture()
      subject.setDeliver(async () => {
        throw new Error('delivery-rejected')
      })

      await subject.announce()
      await subject.complete()
      await subject.settle()
      await vi.runAllTimersAsync()

      expect(subject.sent).toHaveLength(1)
      expect(subject.sent[0]).toContain('feature-stopped: delivery-rejected')
      expect(subject.sent[0]).toContain('normalization-blocked: delivery-rejected')
      expect(subject.sent[0]).toContain('normalization-native: operationId=uw-normalize:')
      expect(subject.sent[0]).toContain('childIds=native-normalization')
    } finally {
      vi.useRealTimers()
    }
  })
})
