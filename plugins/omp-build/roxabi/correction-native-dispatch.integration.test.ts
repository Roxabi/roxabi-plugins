import { describe, expect, it } from 'vitest'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeTask,
} from '../omp/review-runtime/contracts.js'
import type {
  CorrectionActionBinding,
  CorrectionEffectResult,
  NativeCorrectionPort,
} from './correction-execution-contract'
import { dispatchCorrectionAction } from './correction-native-dispatch'

const task: NativeTask = { name: 'fix-apply-RC-1-1', agent: 'fixer', task: 'apply', solutionSpace: 'one cause' }
const binding: CorrectionActionBinding = {
  phase: 'apply',
  causeId: 'RC-1',
  task,
  contextRefs: ['decision-1'],
  context: { causeId: 'RC-1' },
}
function result(batch: NativeBatch, complete = true): NativeBatchResult {
  return { batch, children: [], raw: { native: 'result' }, complete }
}
function bound(
  batch: NativeBatch,
  conserve: (result: NativeBatchResult) => Promise<CorrectionEffectResult<{ contributionIds: string[] }>>,
) {
  return { ok: true as const, value: { batch, conserve } }
}

describe('correction native dispatch', () => {
  it('activates, announces, records start, then returns only after conserving raw native result', async () => {
    const events: string[] = []
    let callbacks: NativeBatchCallbacks | null = null
    let active: NativeBatch | null = null
    const native: NativeCorrectionPort = {
      active: () => active,
      activate(batch, next) {
        events.push('activate')
        active = batch
        callbacks = next
      },
      async announce(batch) {
        events.push('announce')
        active = null
        await callbacks?.onComplete(result(batch))
      },
      async stopOwned() {
        events.push('stop')
      },
    }
    const dispatched = await dispatchCorrectionAction(
      {
        native,
        operationId: 'operation-1',
        signal: new AbortController().signal,
        async bindAction() {
          events.push('bind')
          return bound({ operationId: 'operation-1', tasks: { context: 'test', tasks: [task] } }, async () => {
            events.push('conserve')
            return { ok: true, value: { contributionIds: ['contribution-1'] } }
          })
        },
        async onStarted() {
          events.push('started')
          return { ok: true, value: undefined }
        },
      },
      binding,
    )
    expect(dispatched).toMatchObject({ ok: true, value: { contributionIds: ['contribution-1'] } })
    expect(events).toEqual(['bind', 'activate', 'announce', 'conserve', 'started'])
  })

  it('rechecks abort after authority before binding an inventory or activating native work', async () => {
    const controller = new AbortController()
    const authority = Promise.withResolvers<{ ok: true; value: undefined }>()
    const entered = Promise.withResolvers<void>()
    let boundCount = 0
    const pending = dispatchCorrectionAction(
      {
        native: {
          active: () => null,
          activate() {
            throw new Error('must not activate')
          },
          announce: async () => {
            throw new Error('must not announce')
          },
          stopOwned: async () => {},
        },
        operationId: 'operation-1',
        signal: controller.signal,
        authorizeContinuation: () => {
          entered.resolve()
          return authority.promise
        },
        async bindAction() {
          boundCount += 1
          throw new Error('must not bind')
        },
        async onStarted() {
          throw new Error('must not start')
        },
      },
      binding,
    )
    await entered.promise
    controller.abort()
    authority.resolve({ ok: true, value: undefined })
    await expect(pending).resolves.toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })
    expect(boundCount).toBe(0)
  })

  it('conserves a stopped result once even when abort races an active announcement', async () => {
    const controller = new AbortController()
    let callbacks: NativeBatchCallbacks | null = null
    let active: NativeBatch | null = null
    let stops = 0
    let conserved = 0
    const native: NativeCorrectionPort = {
      active: () => active,
      activate(batch, next) {
        active = batch
        callbacks = next
      },
      async announce() {
        controller.abort()
      },
      async stopOwned(batch) {
        stops += 1
        active = null
        await callbacks?.onStop('fix-run-aborted', result(batch, false))
      },
    }
    const dispatched = await dispatchCorrectionAction(
      {
        native,
        operationId: 'operation-1',
        signal: controller.signal,
        async bindAction() {
          return bound({ operationId: 'operation-1', tasks: { context: 'test', tasks: [task] } }, async () => {
            conserved += 1
            return { ok: true, value: { contributionIds: ['contribution-1'] } }
          })
        },
        async onStarted() {
          return { ok: true, value: undefined }
        },
      },
      binding,
    )
    expect(dispatched).toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })
    expect(conserved).toBe(1)
    expect(stops).toBeGreaterThanOrEqual(1)
  })
})
