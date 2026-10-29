import { afterEach, describe, expect, it } from 'vitest'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { createNativeReviewPort } from '../omp/review-runtime/port.ts'
import { consultableProtocolOptions } from '../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions, root } from '../testing/review-runtime-support.ts'
import type { FeatureCommandHost } from './feature-contract.ts'
import { announceFeatureBatch } from './feature-host-native.ts'

afterEach(() => cleanupFixtureActions())
describe('Feature native host ownership', () => {
  it('retains an incumbent batch when a distinct Feature activation is rejected', async () => {
    const retainedRoot = { ...root, localProtocolOptions: consultableProtocolOptions() }
    const harness = bridgeHarness()
    const port = createNativeReviewPort(harness.native, harness.controller)
    const incumbent = batch(['incumbent'])
    incumbent.operationId = 'feature-A'
    const candidate = batch(['candidate'])
    candidate.operationId = 'feature-B'
    let completed: NativeBatchResult | null = null
    let stopped = 0
    harness.controller.activate(incumbent, {
      onComplete: async (result) => {
        completed = result
      },
      onStop: async () => {
        stopped += 1
      },
    })
    const host: FeatureCommandHost = {
      key: {},
      cwd: '/workspace',
      principal: false,
      workflow: {
        async continueFeature() {
          throw new Error('candidate activation must not continue')
        },
        async consumeWatchExit() {
          throw new Error('candidate activation must not read watch state')
        },
        async publishFeatureNativeResult() {
          throw new Error('candidate activation must not publish')
        },
        async requestFeatureSessionPause() {
          throw new Error('candidate activation must not request pause')
        },
      },
      native: port,
      async send() {},
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {},
      featureContinuationInhibited: () => false,
      markFeatureBatch: (value) => harness.controller.markFeatureBatch(value),
      async exec() {
        throw new Error('candidate activation must not execute')
      },
    }

    try {
      await announceFeatureBatch(
        '#42',
        candidate,
        {
          scope: { repository: 'acme/app', target: 'acme/app#42' },
          recordId: 'action-start-B',
          kind: 'action-receipt',
        },
        host,
        async () => {
          throw new Error('candidate activation must not deliver')
        },
      )

      expect(harness.controller.active()).toBe(incumbent)
      const wire = harness.controller.wire(incumbent)
      expect(wire).not.toBeNull()
      const child = await harness.admitChild(incumbent, 'incumbent', 'incumbent', {
        toolCallId: 'incumbent-call',
        root: retainedRoot,
      })
      await child.message({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'incumbent raw output' },
      })
      await harness.yieldChild('incumbent', { findings: [] }, { toolCallId: 'incumbent-yield' })
      await harness.settleBatch({
        toolCallId: 'incumbent-call',
        errors: [],
        results: [
          {
            index: 0,
            id: 'incumbent',
            agent: 'R-review-adversarial',
            exitCode: 0,
            structuredOutput: { status: 'valid', data: { findings: [] } },
          },
        ],
      })

      expect(stopped).toBe(0)
      expect(completed).toMatchObject({
        complete: true,
        children: [
          {
            id: 'incumbent',
            partialText: 'incumbent raw output',
            submissions: [{ data: { findings: [] } }],
          },
        ],
      })
    } finally {
      await harness.controller.stopOwned(incumbent, 'test-cleanup')
    }
  })
})
