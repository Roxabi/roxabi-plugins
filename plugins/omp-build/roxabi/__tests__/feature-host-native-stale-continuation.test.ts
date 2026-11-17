import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixturePreparedAction } from '../../testing/action-input-fixtures.ts'
import {
  cleanup,
  fixture,
  implementationBatch,
  noDelivery,
  root,
  start,
} from '../../testing/feature-host-native-interruption-fixture.ts'
import { batch, bridgeHarness, fixtureAction } from '../../testing/review-runtime-support.ts'
import type { ContinueFeatureResult } from '../feature-contract.ts'
import { deliverFeatureResult } from '../feature-entry.ts'
import { announceFeatureBatch } from '../feature-host-native.ts'
import { featureCurrent, ownedFeatureFor, rememberFeatureOwner } from '../feature-host-ownership.ts'
import { startDispatch } from '../feature-start-executions.ts'

afterEach(cleanup)

describe('Feature native stale continuation ownership', () => {
  it.each([
    ['43', 'blocked'],
    ['43', 'terminal'],
    ['43', 'action'],
    ['42', 'blocked'],
    ['42', 'terminal'],
    ['42', 'action'],
  ] as const)(
    'does not deliver an older UW 42 decision over fresh UW %s owner (%s)',
    async (successorReference, decision) => {
      const harness = bridgeHarness()
      const { host } = fixture(harness)
      const entered = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<ContinueFeatureResult>()
      const statuses: Array<string | undefined> = []
      host.status = (status) => {
        statuses.push(status)
      }
      host.workflow.continueFeature = async () => {
        entered.resolve()
        return gate.promise
      }
      const first = batch(['slot-a'])
      const staleAction = batch(['stale-action'])
      staleAction.operationId = 'stale-action'
      await announceFeatureBatch('42', first, start(`old-${successorReference}-${decision}`), host, (next) =>
        deliverFeatureResult('42', next, host),
      )
      expect(await harness.admitBatch(first, 'task-call', root)).toBe(true)
      await harness.admitChild(first, 'slot-a', 'slot-a', { root, skipRootCall: true })
      await harness.yieldChild('slot-a', { findings: [] })
      const settling = harness.settleBatch({
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
      await entered.promise
      expect(harness.controller.active()).toBeNull()
      await deliverFeatureResult(
        successorReference,
        {
          kind: 'blocked',
          reason: 'behind',
          next: 'update-branch-then-land',
        },
        host,
      )
      const successor = ownedFeatureFor(host.key)
      const successorStatus = statuses.at(-1)
      expect(successor).toMatchObject({ reference: successorReference, pausable: true })
      gate.resolve(
        decision === 'blocked'
          ? { kind: 'blocked', reason: 'failed-checks' }
          : decision === 'terminal'
            ? { kind: 'terminal', reason: 'merged' }
            : { kind: 'action', node: 'plan', followUp: staleAction, start: start('stale-next-start') },
      )
      try {
        await settling
        expect(ownedFeatureFor(host.key)).toBe(successor)
        expect(statuses.at(-1)).toBe(successorStatus)
        expect(harness.controller.active()).toBeNull()
        if (decision === 'action') {
          // Continuation may already have published the START; only dispatch is refused.
          expect(startDispatch(start('stale-next-start'))).toEqual({ kind: 'not-activated' })
        }
      } finally {
        await harness.controller.stopOwned(staleAction, 'test-cleanup')
      }
    },
  )

  it('does not begin the old continuation if ownership changed during completed-result publication', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let continuations = 0
    host.workflow.publishFeatureNativeResult = async () => {
      entered.resolve()
      await gate.promise
      return { published: true, retained: true }
    }
    host.workflow.continueFeature = async () => {
      continuations += 1
      return { kind: 'terminal', reason: 'merged' }
    }
    const first = batch(['slot-a'])
    await announceFeatureBatch('42', first, start('old-complete-start'), host, (next) =>
      deliverFeatureResult('42', next, host),
    )
    expect(await harness.admitBatch(first, 'old-complete-call', root)).toBe(true)
    await harness.admitChild(first, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await harness.yieldChild('slot-a', { findings: [] })
    const settling = harness.settleBatch({
      toolCallId: 'old-complete-call',
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
    await entered.promise
    await deliverFeatureResult('43', { kind: 'blocked', reason: 'behind', next: 'update-branch-then-land' }, host)
    const successor = ownedFeatureFor(host.key)
    gate.resolve()
    await settling
    expect(continuations).toBe(0)
    expect(ownedFeatureFor(host.key)).toBe(successor)
  })

  it('records an inhibited action as not dispatched without claiming business effects did not occur', async () => {
    const harness = bridgeHarness()
    const { host, sent } = fixture(harness)
    host.featureContinuationInhibited = () => true
    const ref = start('entry-inhibited-start')
    await deliverFeatureResult('42', { kind: 'action', node: 'plan', followUp: batch(['inhibited']), start: ref }, host)
    expect(harness.controller.active()).toBeNull()
    expect(startDispatch(ref)).toEqual({ kind: 'not-activated' })
    expect(sent).toEqual(['feature-stopped: continuation-inhibited'])
  })

  it('does not activate a stale implementation after its asynchronous baseline read', async () => {
    const harness = bridgeHarness()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<{ stdout: string; exitCode: number }>()
    const { host } = fixture(harness, {
      git: async () => {
        entered.resolve()
        return gate.promise
      },
    })
    rememberFeatureOwner(host.key, { reference: '42', cwd: host.cwd, pausable: true })
    const ref = start('baseline-stale-start')
    const announcing = announceFeatureBatch('42', implementationBatch(), ref, host, noDelivery)
    await entered.promise
    await deliverFeatureResult('43', { kind: 'blocked', reason: 'behind', next: 'update-branch-then-land' }, host)
    const successor = ownedFeatureFor(host.key)
    gate.resolve({ stdout: 'a'.repeat(40), exitCode: 0 })
    await announcing
    expect(ownedFeatureFor(host.key)).toBe(successor)
    expect(harness.controller.active()).toBeNull()
    expect(startDispatch(ref)).toEqual({ kind: 'not-activated' })
  })

  it('does not activate an implementation when its predecessor aborts during baseline observation', async () => {
    const harness = bridgeHarness()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<{ stdout: string; exitCode: number }>()
    const { host } = fixture(harness, {
      git: async () => {
        entered.resolve()
        return gate.promise
      },
    })
    const ref = start('baseline-aborted-start')
    let current = true
    const delivery = deliverFeatureResult(
      '42',
      {
        kind: 'action',
        node: 'implement',
        followUp: implementationBatch(),
        start: ref,
      },
      host,
      () => current,
    )
    await entered.promise
    current = false
    gate.resolve({ stdout: 'a'.repeat(40), exitCode: 0 })
    await delivery
    expect(harness.controller.active()).toBeNull()
    expect(startDispatch(ref)).toEqual({ kind: 'not-activated' })
  })

  it('keeps the predecessor guard live while review preparation is pending', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let launched = false
    let current = true
    host.startReview = async (_reference, _onComplete, guard) => {
      entered.resolve()
      await gate.promise
      if (guard?.()) launched = true
    }
    const previous = { reference: '42', cwd: host.cwd, pausable: true }
    rememberFeatureOwner(host.key, previous)
    const delivery = deliverFeatureResult('42', { kind: 'review', pr: 7 }, host, () => current)
    await entered.promise
    current = false
    gate.resolve()
    await delivery
    expect(launched).toBe(false)
    expect(ownedFeatureFor(host.key)).toBe(previous)
  })

  it.each(['current', 'aborted', 'replaced'] as const)(
    'keeps deferred successor authority bound to its new owner (%s)',
    async (state) => {
      const harness = bridgeHarness()
      const { host } = fixture(harness)
      const predecessor = { reference: '42', cwd: host.cwd, pausable: true }
      rememberFeatureOwner(host.key, predecessor)
      let live = true
      const current = featureCurrent(host.key, predecessor, () => live)
      let announcementGuard: (() => boolean) | undefined
      host.native.announce = async (_batch, guard) => {
        announcementGuard = guard
      }
      const successor = batch(['deferred-successor'])
      await announceFeatureBatch('42', successor, start(`deferred-${state}`), host, noDelivery, current)
      expect(ownedFeatureFor(host.key)).not.toBe(predecessor)
      if (state === 'aborted') live = false
      if (state === 'replaced') rememberFeatureOwner(host.key, { reference: '43', cwd: host.cwd, pausable: true })
      expect(announcementGuard?.()).toBe(state === 'current')
      await harness.controller.stopOwned(successor, 'test-cleanup')
    },
  )

  it('does not deliver an old missing-context stop after its publication outlives a successor', async () => {
    const harness = bridgeHarness()
    const { host } = fixture(harness)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const statuses: Array<string | undefined> = []
    host.status = (status) => {
      statuses.push(status)
    }
    host.workflow.publishFeatureNativeResult = async () => {
      entered.resolve()
      await gate.promise
      return { published: true, retained: true, receipt: start('negative-receipt') }
    }
    const action = fixturePreparedAction('old-negative')
    const first = batch(['old-negative'])
    first.operationId = 'old-negative'
    const task = first.tasks.tasks[0]
    if (task === undefined) throw new Error('expected a task')
    task.agent = 'R-workflow-plan'
    task.action = fixtureAction('old-negative', task.agent, action.inputs)
    const negative = {
      outcome: 'missing-context',
      missing: [
        {
          locator: { kind: 'file-request', repository: 'acme/app', path: 'src/policy.ts', revisionHint: null },
          reason: 'The policy is required to assess the plan',
          targets: [],
        },
      ],
    }
    try {
      await announceFeatureBatch('42', first, start('old-negative-start'), host, (next) =>
        deliverFeatureResult('42', next, host),
      )
      expect(await harness.admitBatch(first, 'negative-call', root)).toBe(true)
      await harness.admitChild(first, 'old-negative', 'old-negative-2', { root, skipRootCall: true })
      await harness.yieldChild('old-negative-2', negative)
      const settling = harness.settleBatch({
        toolCallId: 'negative-call',
        errors: [],
        results: [
          {
            index: 0,
            id: 'old-negative-2',
            agent: 'R-workflow-plan',
            exitCode: 0,
            structuredOutput: { status: 'valid', data: negative },
          },
        ],
      })
      await entered.promise
      expect(harness.controller.active()).toBeNull()
      await deliverFeatureResult(
        '43',
        {
          kind: 'blocked',
          reason: 'behind',
          next: 'update-branch-then-land',
        },
        host,
      )
      const successor = ownedFeatureFor(host.key)
      const successorStatus = statuses.at(-1)
      expect(successor).toMatchObject({ reference: '43', pausable: true })
      gate.resolve()
      await settling
      expect(ownedFeatureFor(host.key)).toBe(successor)
      expect(statuses.at(-1)).toBe(successorStatus)
    } finally {
      gate.resolve()
      rmSync(dirname(action.snapshot.indexPath), { recursive: true, force: true })
    }
  })
})
