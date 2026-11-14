import { afterEach, describe, expect, it } from 'vitest'
import type { NativeBatchCallbacks } from '../../omp/review-runtime/contracts.ts'
import {
  cleanup,
  fixture,
  implementationBatch,
  noDelivery,
  root,
  start,
} from '../../testing/feature-host-native-interruption-fixture.ts'
import { batch, bridgeHarness } from '../../testing/review-runtime-support.ts'
import { announceFeatureBatch } from '../feature-host-native.ts'
import { ownedFeatureFor, rememberFeatureOwner } from '../feature-host-ownership.ts'
import { startDispatch } from '../feature-start-executions.ts'

afterEach(cleanup)

describe('Feature native owner acquisition and typed stop forwarding', () => {
  it('keeps the incumbent owner when the Feature activation is refused', async () => {
    const harness = bridgeHarness()
    const incumbent = batch(['incumbent'])
    harness.controller.activate(incumbent, { onComplete: async () => undefined, onStop: async () => undefined })
    const { host, sent, published } = fixture(harness)
    const owner = { reference: '7', cwd: '/workspace', pausable: true }
    rememberFeatureOwner(host.key, owner)
    const candidate = batch(['candidate'])
    candidate.operationId = 'feature-B'

    try {
      await announceFeatureBatch('42', candidate, start('activation-refused-start'), host, noDelivery)

      expect(harness.controller.active()).toBe(incumbent)
      expect(ownedFeatureFor(host.key)).toEqual(owner)
      expect(sent).toEqual(['feature-stopped: a native batch is already active'])
      expect(published).toEqual([])
      expect(startDispatch(start('activation-refused-start'))).toEqual({ kind: 'not-activated' })
    } finally {
      await harness.controller.stopOwned(incumbent, 'test-cleanup')
    }
  })

  it('claims no owner and activates nothing when the implementation baseline is unobserved', async () => {
    const harness = bridgeHarness()
    const { host, sent, published } = fixture(harness, { git: async () => ({ stdout: '', exitCode: 128 }) })

    await announceFeatureBatch('42', implementationBatch(), start('act-implement-1-start'), host, noDelivery)

    expect(sent).toEqual(['feature-stopped: implementation-start-unobserved'])
    expect(harness.controller.active()).toBeNull()
    expect(ownedFeatureFor(host.key)).toBeUndefined()
    expect(published).toEqual([])
  })

  it('claims the owner only after activation and forwards the typed host stop to the publisher', async () => {
    const harness = bridgeHarness()
    const { host, published } = fixture(harness)
    const prepared = batch(['slot-a'])

    await announceFeatureBatch('42', prepared, start('act-plan-1-start'), host, noDelivery)
    expect(harness.controller.active()).toBe(prepared)
    expect(ownedFeatureFor(host.key)).toEqual({ reference: '42', cwd: '/workspace', pausable: true })

    await harness.controller.stopOwned(prepared, 'pause')

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      cwd: '/workspace',
      start: start('act-plan-1-start'),
      stop: { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' },
    })
  })

  it('records closure only after the real pre-admission stop callback', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('tracker-claim-start')
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
    await harness.controller.stopOwned(prepared, 'pause')
    expect(startDispatch(ref)).toEqual({ kind: 'closed-before-admission', operationId: prepared.operationId })
  })

  it('keeps the START activated until its stopped RESULT is confirmed retained', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('pending-stop-publication-start')
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<{ published: true; retained: true }>()
    host.workflow.publishFeatureNativeResult = async () => {
      entered.resolve()
      return gate.promise
    }
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    const stopping = harness.controller.stopOwned(prepared, 'pause')
    await entered.promise
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
    gate.resolve({ published: true, retained: true })
    await stopping
    expect(startDispatch(ref)).toEqual({ kind: 'closed-before-admission', operationId: prepared.operationId })
  })

  it.each(['unretained', 'throw'] as const)('keeps START activated after %s terminal publication', async (failure) => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start(`failed-stop-publication-${failure}`)
    host.workflow.publishFeatureNativeResult = async () => {
      if (failure === 'throw') throw new Error('publication unavailable')
      return { published: false, retained: false, reason: 'retention-unconfirmed' }
    }
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    await harness.controller.stopOwned(prepared, 'pause').catch(() => undefined)
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
  })

  it('does not close a START when a pre-admission callback has no RESULT to retain', async () => {
    const harness = bridgeHarness()
    const { host, published } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('null-stop-result-start')
    let stopped: NativeBatchCallbacks['onStop'] = async () => {
      throw new Error('callback not captured')
    }
    const activate = host.native.activate
    host.native.activate = (value, callbacks) => {
      stopped = callbacks.onStop
      activate(value, callbacks)
    }
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    await stopped('pause', null, { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' })
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
    expect(published).toEqual([])
    await harness.controller.stopOwned(prepared, 'cleanup')
  })

  it('reports the confirmed remote tip in both the owned failure and retention error', async () => {
    const harness = bridgeHarness()
    const { host, sent } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('reported-push-start')
    const reasons: string[] = []
    const activate = host.native.activate
    host.native.activate = (value, callbacks) =>
      activate(value, {
        ...callbacks,
        onStop: async (reason, result, stop) => {
          reasons.push(reason)
          await callbacks.onStop(reason, result, stop)
        },
      })
    host.workflow.publishFeatureNativeResult = async () => ({
      published: false,
      retained: false,
      reason: 'retention-unconfirmed',
      confirmedRemote: { branch: 'feature/42', tip: 'abc123' },
    })
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    expect(await harness.admitBatch(prepared, 'reported-push-call', root)).toBe(true)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    await harness.settleBatch({
      toolCallId: 'reported-push-call',
      errors: [],
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { findings: [] } },
        },
      ],
    })
    expect(sent.join('\n')).toContain('retention-unconfirmed')
    expect(sent.join('\n')).toContain('feature/42')
    expect(sent.join('\n')).toContain('abc123')
    expect(reasons.join('\n')).toContain('feature/42')
    expect(reasons.join('\n')).toContain('abc123')
  })

  it.each([
    ['completed', false],
    ['completed', true],
    ['stopped', false],
    ['stopped', true],
  ] as const)('preserves %s publication facts when notification fails (retained=%s)', async (mode, retained) => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const prepared = batch(['slot-a'])
    let callbacks: NativeBatchCallbacks | undefined
    host.native.activate = (_batch, value) => {
      callbacks = value
    }
    const notification = new Error('notification unavailable')
    host.send = async () => {
      throw notification
    }
    host.workflow.publishFeatureNativeResult = async () => ({
      published: false,
      retained,
      reason: 'publication refused',
      confirmedRemote: { branch: 'feature/42', tip: 'abc123' },
    })
    await announceFeatureBatch('42', prepared, start(`notify-${mode}-${retained}`), host, noDelivery)
    if (callbacks === undefined) throw new Error('native callbacks not captured')
    const result = { batch: prepared, children: [], raw: null, complete: true }
    const pending =
      mode === 'completed'
        ? callbacks.onComplete(result, () => true)
        : callbacks.onStop('pause', result, { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' })
    const error = await Promise.resolve(pending).then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    expect(aggregate.message).toContain('publication refused')
    expect(aggregate.message).toContain('feature/42')
    expect(aggregate.message).toContain('abc123')
    expect(aggregate.errors).toContain(notification)
    expect(
      aggregate.errors.some((item: unknown) => item instanceof Error && item.message.includes('publication refused')),
    ).toBe(true)
    if (retained) expect(aggregate.message).not.toMatch(/unretained|retention.unconfirmed/i)
  })

  it.each(['completed', 'stopped'] as const)(
    'preserves the original publisher exception and cause when %s notification fails',
    async (mode) => {
      const harness = bridgeHarness()
      const { host } = fixture(harness)
      const prepared = batch(['slot-a'])
      let callbacks: NativeBatchCallbacks | undefined
      host.native.activate = (_batch, value) => {
        callbacks = value
      }
      const cause = new Error('original cause')
      const primary = new Error('publisher unavailable', { cause })
      const notification = new Error('notification unavailable')
      host.workflow.publishFeatureNativeResult = async () => {
        throw primary
      }
      host.send = async () => {
        throw notification
      }
      await announceFeatureBatch('42', prepared, start(`notify-throw-${mode}`), host, noDelivery)
      if (callbacks === undefined) throw new Error('native callbacks not captured')
      const result = { batch: prepared, children: [], raw: null, complete: true }
      const pending =
        mode === 'completed'
          ? callbacks.onComplete(result, () => true)
          : callbacks.onStop('pause', result, { kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' })
      const error = await Promise.resolve(pending).then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError
      expect(aggregate.message).toContain('publisher unavailable')
      expect(aggregate.errors).toContain(primary)
      expect(aggregate.errors).toContain(notification)
      expect(primary.cause).toBe(cause)
    },
  )

  it('closes through the native stop fence rather than minting not-activated after announcement throws', async () => {
    const harness = bridgeHarness()
    const { host, sent } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('announcement-failure-start')
    host.native.announce = async () => {
      throw new Error('announcement failed')
    }
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    expect(startDispatch(ref)).toEqual({ kind: 'closed-before-admission', operationId: prepared.operationId })
    expect(sent).toContain('feature-stopped: announcement failed')
  })

  it('rejects a later native activation after the START was refused before activation', async () => {
    const harness = bridgeHarness()
    const { host, sent } = fixture(harness)
    const ref = start('refused-then-activation-start')
    host.featureContinuationInhibited = () => true
    await announceFeatureBatch('42', batch(['slot-a']), ref, host, noDelivery)
    host.featureContinuationInhibited = () => false
    await announceFeatureBatch('42', batch(['slot-b']), ref, host, noDelivery)
    expect(harness.controller.active()).toBeNull()
    expect(startDispatch(ref)).toEqual({ kind: 'conflict' })
    expect(sent.at(-1)).toBe('feature-stopped: action-start-already-observed')
  })

  it('does not close an admitted START when stop is requested or when its SDK result arrives', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const prepared = batch(['slot-a'])
    const ref = start('admitted-stop-start')
    await announceFeatureBatch('42', prepared, ref, host, noDelivery)
    expect(await harness.admitBatch(prepared, 'admitted-stop-call', root)).toBe(true)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    const stopping = harness.controller.stopOwned(prepared, 'pause')
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
    await harness.settleBatch({
      toolCallId: 'admitted-stop-call',
      errors: ['aborted'],
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-adversarial',
          exitCode: 1,
          aborted: true,
        },
      ],
    })
    await stopping
    expect(startDispatch(ref)).toEqual({ kind: 'activated', operationId: prepared.operationId })
  })

  it('does not publish a second time when a stop lands after the completed result was published', async () => {
    const harness = bridgeHarness()
    const prepared = batch(['slot-a'])
    const { host, published } = fixture(harness, {
      publish: (_input, all) => {
        // Un-awaited: the stop joins the in-flight terminal instead of the callback joining itself.
        if (all.length === 1) void harness.controller.stopOwned(prepared, 'pause')
      },
    })

    await announceFeatureBatch('42', prepared, start('late-complete-start'), host, noDelivery)
    expect(await harness.admitBatch(prepared, 'task-call', root)).toBe(true)
    await harness.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    await harness.settleBatch({
      toolCallId: 'task-call',
      errors: [],
      results: [
        {
          index: 0,
          id: 'slot-a',
          agent: 'R-review-adversarial',
          exitCode: 0,
          structuredOutput: { status: 'valid', data: { findings: [] } },
        },
      ],
    })

    expect(published).toHaveLength(1)
    expect(published[0]).not.toHaveProperty('stop')
    expect(published[0]).toMatchObject({ result: { complete: true } })
  })
})
