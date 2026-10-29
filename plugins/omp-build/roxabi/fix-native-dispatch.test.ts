import { describe, expect, it } from 'vitest'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { fixturePreparedAction, fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import type { NativePort } from './fix-contract.ts'
import { dispatchNativeBatch } from './fix-native-dispatch.ts'

const batch: NativeBatch = {
  operationId: 'operation-1',
  tasks: {
    context: 'correction intake',
    tasks: [
      {
        name: 'slot-1',
        agent: 'R-adversarial',
        task: 'inspect correction scope',
        solutionSpace: 'correction evidence only',
        action: fixturePreparedAction('slot-1'),
      },
    ],
  },
}

describe('fix native dispatch', () => {
  it('returns the stop failure after conserving a stopped native batch', async () => {
    let active: NativeBatch | null = null
    let callbacks: NativeBatchCallbacks | null = null
    const stopped: NativeBatchResult = { batch, children: [], raw: { reason: 'session-switched' }, complete: false }
    const native: NativePort = {
      active: () => active,
      activate(next, registered) {
        active = next
        callbacks = registered
      },
      async announce() {
        active = null
        if (callbacks === null) throw new Error('native callbacks missing')
        await callbacks.onStop('session-switched', stopped)
      },
      async stopOwned() {
        active = null
      },
    }
    const conserved: NativeBatchResult[] = []

    const result = await dispatchNativeBatch(
      native,
      batch,
      {
        signal: new AbortController().signal,
        uw: fixtureUwOperations(),
        onBatch: () => {},
        onStarted: () => {},
      },
      async (nativeResult) => {
        conserved.push(nativeResult)
        return { ok: true, value: { retained: true } }
      },
      true,
    )

    expect(conserved).toEqual([stopped])
    expect(result).toEqual({ ok: false, diagnostics: ['native-batch-stopped:session-switched'] })
  })
})
