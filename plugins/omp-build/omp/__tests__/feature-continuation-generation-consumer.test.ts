import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import {
  deliverFeatureResult,
  isRunnableFeatureResult,
  runInstalledFeatureCommand,
} from '../../roxabi/feature-entry.ts'
import { createExtensionApiStub, fixtureEventBus } from '../../testing/extension-api-stub.ts'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import ompBuildExtension from '../index.ts'
import { reviewControllerFor } from '../omp-controller.ts'
import { createFeatureCommandHost, type FeatureCommandComposition } from '../omp-feature-command-host.ts'
import {
  beginFeatureUwIntake,
  createFeatureOperationReportGuard,
  type FeatureOperationReportGuard,
  installFeatureUwOperationLifecycle,
} from '../omp-feature-composition.ts'
import { createOperatorConfirmation } from '../omp-operator-confirmation.ts'
import type { NativeBatch } from '../review-runtime/contracts.ts'
import type { NativeBatchController } from '../review-runtime/controller.ts'
import { batch, root } from './feature-command-lifecycle-fixture.ts'

afterEach(() => {
  cleanupFixtureActions()
})

beforeEach(() => {
  root.localProtocolOptions = consultableProtocolOptions()
  Object.assign(root.sessionManager, { getArtifactsDir: root.localProtocolOptions.getArtifactsDir })
})

function planAction(startId = 'start-plan'): Extract<ContinueFeatureResult, { kind: 'action' }> {
  return {
    kind: 'action',
    node: 'plan',
    followUp: batch(startId),
    start: {
      scope: { repository: 'acme/app', target: 'acme/app#42' },
      recordId: startId,
      kind: 'action-receipt',
    },
  }
}

/** Confirmed resume reentry can end here; select/resume must still epoch-release. */
function actionContextMissing(): Extract<ContinueFeatureResult, { kind: 'blocked' }> {
  return { kind: 'blocked', reason: 'action-context-missing' }
}

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return {
    continueFeature: async () => actionContextMissing(),
    consumeWatchExit: async () => actionContextMissing(),
    publishFeatureNativeResult: async () => ({
      published: false as const,
      reason: 'fixture-unpublished',
      retained: false,
    }),
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: true, reason: 'pause-confirmed' }),
    ...impl,
  }
}

const coverageRequest = {
  parent: { uw: { repository: 'acme/app', target: 'acme/app#1' }, version: 'a'.repeat(64) },
  accepted: null,
  inheritedOwnSpecRefs: [],
  criteria: [{ id: 'C1', statement: 'Deliver' }],
  children: [],
}

function coverageBlocked(): Extract<ContinueFeatureResult, { kind: 'blocked' }> {
  return {
    kind: 'blocked',
    reason: 'parent-coverage-intent-required',
    coverageRequest,
  }
}

/** Installed `/feature` entry — actual `runFeatureCommand` consumer. */
function installed(options: { featureWorkflow: FeatureWorkflow }) {
  const sent: string[] = []
  const commands = new Map<string, { handler: (args: string, ctx: typeof root) => Promise<void> }>()
  const registered = new Map<string, Array<(...args: never[]) => unknown>>()
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      const listeners = registered.get(event) ?? []
      listeners.push(handler as (...args: never[]) => unknown)
      registered.set(event, listeners)
    },
    events: fixtureEventBus(() => () => undefined),
    registerCommand: (name, command) => {
      commands.set(name, command as { handler: (args: string, ctx: typeof root) => Promise<void> })
    },
    registerTool: () => undefined,
    sendUserMessage: async (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
  })
  provisionNativeRoot(root)
  ompBuildExtension(pi, { principalCwd: () => false, ...options })
  return { sent, commands, pi, controller: reviewControllerFor(pi) }
}

type HostSession = {
  pi: ReturnType<typeof createExtensionApiStub>
  controller: NativeBatchController
  composition: FeatureCommandComposition
  report: FeatureOperationReportGuard
  operator: ReturnType<typeof createOperatorConfirmation>
}

function openHostSession(): HostSession {
  const pi = createExtensionApiStub({
    sendMessage: () => undefined,
    sendUserMessage: async () => undefined,
  })
  installFeatureUwOperationLifecycle(pi)
  provisionNativeRoot(root)
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(root as never)
  const operator = createOperatorConfirmation(root as never)
  const report = createFeatureOperationReportGuard(pi, root as never, operator)
  beginFeatureUwIntake(pi, operator, root as never)
  const composition: FeatureCommandComposition = {
    pi,
    options: { principalCwd: () => false },
    interruptOwnedFeatureWork: async () => undefined,
    framing: {
      start: async () => {
        throw new Error('unexpected-fixture-framing')
      },
    },
  }
  return { pi, controller, composition, report, operator }
}

/** Actual `createFeatureCommandHost` consumer bound to a captured ingress epoch on one controller. */
function hostOn(
  session: HostSession,
  ingressEpoch: number,
  impl: {
    continueFeature: FeatureWorkflow['continueFeature']
    requestParentCoverage?: NonNullable<FeatureCommandHost['requestParentCoverage']>
    announceGate?: () => Promise<void>
  },
): {
  host: FeatureCommandHost
  sent: string[]
  announced: NativeBatch[]
  releases: Array<{ epoch: number; ok: boolean }>
} {
  const sent: string[] = []
  const announced: NativeBatch[] = []
  const releases: Array<{ epoch: number; ok: boolean }> = []
  session.pi.sendMessage = (message: unknown) => {
    sent.push(typeof message === 'string' ? message : String((message as { content?: unknown })?.content ?? message))
  }
  session.pi.sendUserMessage = async (content: string) => {
    sent.push(String(content))
  }
  const featureWorkflow = workflow({ continueFeature: impl.continueFeature })
  session.composition = {
    ...session.composition,
    options: { principalCwd: () => false, featureWorkflow },
  }
  const host = createFeatureCommandHost(
    session.composition,
    { ctx: root as never, operator: session.operator, originalArgs: 'new #42' },
    featureWorkflow,
    session.controller,
    undefined,
    session.report,
    undefined,
    ingressEpoch,
  )
  const release = host.releaseFeatureContinuation.bind(host)
  host.releaseFeatureContinuation = () => {
    const ok = release()
    releases.push({ epoch: ingressEpoch, ok })
    return ok
  }
  if (impl.requestParentCoverage !== undefined) host.requestParentCoverage = impl.requestParentCoverage
  const announce = host.native.announce.bind(host.native)
  host.native.announce = async (followUp, current) => {
    if (impl.announceGate !== undefined) await impl.announceGate()
    await announce(followUp, current)
    announced.push(followUp)
  }
  return { host, sent, announced, releases }
}

describe('feature continuation generation consumer', () => {
  it('runFeatureCommand captures ingress before pin/workflow awaits; ABA while authority pending refuses release', async () => {
    const authorityEntered = Promise.withResolvers<void>()
    const releaseAuthority = Promise.withResolvers<void>()
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async () => {
          authorityEntered.resolve()
          await releaseAuthority.promise
          return planAction('authority-race')
        },
      }),
    })
    host.controller.inhibitFeatureContinuation()
    const ingressEpoch = host.controller.featureContinuationEpoch()

    const running = host.commands.get('feature')?.handler('new #42', root)
    if (running === undefined) throw new Error('feature-command-unregistered')
    await authorityEntered.promise
    // Later stop/inhibit while authority (continueFeature) is still pending after pin/workflow awaits.
    host.controller.inhibitFeatureContinuation()
    expect(host.controller.featureContinuationEpoch()).toBeGreaterThan(ingressEpoch)
    releaseAuthority.resolve()
    await running

    expect(host.controller.featureContinuationInhibited()).toBe(true)
    expect(host.sent.some((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toBe(false)
    expect(host.sent.some((message) => message.includes('continuation-inhibited'))).toBe(false)
  })

  it('createFeatureCommandHost confirmation-pending ABA refuses stale ingress unlock', async () => {
    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    const confirmationEntered = Promise.withResolvers<void>()
    const releaseConfirmation = Promise.withResolvers<void>()
    const race = hostOn(session, ingressEpoch, {
      continueFeature: async () => {
        // Synthetic confirmation wait — fixture never live-approves.
        confirmationEntered.resolve()
        await releaseConfirmation.promise
        return planAction('confirmation-race')
      },
    })

    const running = runInstalledFeatureCommand('new #42', race.host)
    await confirmationEntered.promise
    session.controller.inhibitFeatureContinuation()
    expect(session.controller.featureContinuationEpoch()).toBeGreaterThan(ingressEpoch)
    // A newer owner clears its stop: the old command still cannot dispatch through this ABA cycle.
    expect(session.controller.releaseFeatureContinuation(session.controller.featureContinuationEpoch())).toBe(true)
    releaseConfirmation.resolve()
    await running

    expect(race.releases).toEqual([{ epoch: ingressEpoch, ok: false }])
    expect(race.announced).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(false)
  })

  it('createFeatureCommandHost coverage-pending ABA refuses stale ingress unlock', async () => {
    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    const coverageEntered = Promise.withResolvers<void>()
    const releaseCoverage = Promise.withResolvers<void>()
    const race = hostOn(session, ingressEpoch, {
      continueFeature: async (input) => {
        if (input.parentCoverage !== undefined) return planAction('after-coverage')
        return coverageBlocked()
      },
      requestParentCoverage: async () => {
        coverageEntered.resolve()
        await releaseCoverage.promise
        return {
          kind: 'proposed',
          coverage: {
            parent: coverageRequest.parent,
            assignments: [],
          },
        }
      },
    })

    const running = runInstalledFeatureCommand('new #42', race.host)
    await coverageEntered.promise
    session.controller.inhibitFeatureContinuation()
    expect(session.controller.featureContinuationEpoch()).toBeGreaterThan(ingressEpoch)
    releaseCoverage.resolve()
    await running

    expect(race.releases).toEqual([{ epoch: ingressEpoch, ok: false }])
    expect(race.announced).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(true)
  })

  it('createFeatureCommandHost START-announce-pending ABA cancels model-facing dispatch after unlock', async () => {
    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    const startEntered = Promise.withResolvers<void>()
    const releaseStart = Promise.withResolvers<void>()
    const action = planAction('start-race')
    const race = hostOn(session, ingressEpoch, {
      continueFeature: async () => action,
      announceGate: async () => {
        startEntered.resolve()
        await releaseStart.promise
      },
    })

    const running = runInstalledFeatureCommand('new #42', race.host)
    await startEntered.promise
    // Release already compare-cleared; a later inhibit during START announce must cancel dispatchCurrent.
    session.controller.inhibitFeatureContinuation()
    expect(session.controller.featureContinuationEpoch()).toBeGreaterThan(ingressEpoch)
    releaseStart.resolve()
    await running

    expect(race.releases).toEqual([{ epoch: ingressEpoch, ok: true }])
    expect(race.announced).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(true)
    expect(race.sent.some((message) => message.includes('feature-stopped'))).toBe(true)
  })

  it('matching createFeatureCommandHost epoch with lost operation generation still suppresses release', async () => {
    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    const race = hostOn(session, ingressEpoch, { continueFeature: async () => planAction() })
    // Replacement intake advances operation generation — host retains the stale bound generation.
    const replacement = createOperatorConfirmation(root as never)
    beginFeatureUwIntake(session.pi, replacement, root as never)

    await runInstalledFeatureCommand('new #42', race.host)
    expect(race.releases).toEqual([{ epoch: ingressEpoch, ok: false }])
    expect(race.announced).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(true)
  })

  it('public pause and abandon still confirm despite own inhibit', async () => {
    for (const control of ['pause', 'abandon'] as const) {
      const session = openHostSession()
      const race = hostOn(session, session.controller.featureContinuationEpoch(), {
        continueFeature: async (input) => {
          if (input.owned?.() !== true) return { kind: 'blocked', reason: 'administrative-authority-lost' }
          return control === 'pause'
            ? { kind: 'paused', confirmed: true, reason: 'pause-confirmed' }
            : { kind: 'abandoned', confirmed: true }
        },
      })
      const prepared = batch(`owned-${control}`)
      session.controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
      session.controller.markFeatureBatch(prepared)
      expect(session.controller.announce(prepared)).toBe(true)

      let interrupted = false
      race.host.interruptOwnedWork = async () => {
        interrupted = true
        return await session.controller.stopJoined(control)
      }

      await runInstalledFeatureCommand(`${control} #42`, race.host)
      expect(interrupted).toBe(true)
      expect(session.controller.featureContinuationInhibited()).toBe(true)
      expect(race.sent).toContain(control === 'pause' ? 'pause-confirmed: pause-confirmed' : 'feature-abandoned')
    }
  })

  it('select/resume epoch-release even when reentry ends action-context-missing; --action never clears unrelated latch', async () => {
    for (const control of ['resume', 'select'] as const) {
      const session = openHostSession()
      session.controller.inhibitFeatureContinuation()
      const epoch = session.controller.featureContinuationEpoch()
      const race = hostOn(session, epoch, { continueFeature: async () => actionContextMissing() })
      await runInstalledFeatureCommand(control === 'resume' ? 'resume #42' : '#42', race.host)
      expect(isRunnableFeatureResult(actionContextMissing())).toBe(false)
      expect(race.releases).toEqual([{ epoch, ok: true }])
      expect(session.controller.featureContinuationInhibited()).toBe(false)
    }

    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const resumeEpoch = session.controller.featureContinuationEpoch()
    const resumeHost = hostOn(session, resumeEpoch, { continueFeature: async () => actionContextMissing() })
    await runInstalledFeatureCommand('resume #42', resumeHost.host)
    expect(session.controller.featureContinuationInhibited()).toBe(false)
    const continued = planAction('resumed-context-action')
    const resumedAction = hostOn(session, session.controller.featureContinuationEpoch(), {
      continueFeature: async () => continued,
    })
    await runInstalledFeatureCommand(`#42 --action ${root.cwd}/fictional-action.json`, resumedAction.host)
    expect(resumedAction.releases).toEqual([])
    expect(resumedAction.announced).toEqual([continued.followUp])
    await session.controller.stopOwned(continued.followUp, 'fixture-action-complete')

    session.controller.inhibitFeatureContinuation()
    const unrelated = session.controller.featureContinuationEpoch()
    const actionReleases: Array<{ epoch: number; ok: boolean }> = []
    const action = hostOn(session, unrelated, {
      continueFeature: async (input) => {
        expect(input.control).toBe('recover-context')
        return planAction('start-after-action')
      },
    })
    const release = action.host.releaseFeatureContinuation.bind(action.host)
    action.host.releaseFeatureContinuation = () => {
      const ok = release()
      actionReleases.push({ epoch: unrelated, ok })
      return ok
    }
    await runInstalledFeatureCommand(`#42 --action ${root.cwd}/fictional-action.json`, action.host)
    expect(actionReleases).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(true)
    expect(session.controller.featureContinuationEpoch()).toBe(unrelated)
  })

  it('runnable new compare-and-releases the captured ingress epoch before announce', async () => {
    const session = openHostSession()
    const oldBatch = batch('old-tracked')
    session.controller.activate(oldBatch, { onComplete: async () => undefined, onStop: async () => undefined })
    session.controller.markFeatureBatch(oldBatch)
    expect(session.controller.announce(oldBatch)).toBe(true)
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    session.controller.inactive()

    const action = planAction('runnable-new')
    const race = hostOn(session, ingressEpoch, { continueFeature: async () => action })
    await runInstalledFeatureCommand('new #42', race.host)
    expect(isRunnableFeatureResult(action)).toBe(true)
    expect(race.releases).toEqual([{ epoch: ingressEpoch, ok: true }])
    expect(session.controller.featureContinuationInhibited()).toBe(false)
    expect(race.announced).toEqual([action.followUp])
    expect(race.sent.some((message) => message.includes('continuation-inhibited'))).toBe(false)
  })

  it('blocked public new does not release and deliverFeatureResult fences the START', async () => {
    const session = openHostSession()
    session.controller.inhibitFeatureContinuation()
    const ingressEpoch = session.controller.featureContinuationEpoch()
    const race = hostOn(session, ingressEpoch, { continueFeature: async () => actionContextMissing() })

    await runInstalledFeatureCommand('new #42', race.host)
    expect(race.releases).toEqual([])
    expect(session.controller.featureContinuationInhibited()).toBe(true)
    expect(race.announced).toEqual([])

    const action = planAction('fenced-start')
    await deliverFeatureResult('#42', action, race.host)
    expect(race.announced).toEqual([])
    expect(race.sent.some((message) => message.includes('continuation-inhibited'))).toBe(true)
  })

  it('runFeatureCommand pinload-pending ABA: inhibit between ingress capture and authority refuses release', async () => {
    // Installed featureWorkflow short-circuits UW load; the first controllable await after
    // ingress capture + hostPluginPin is continueFeature. Bumping the epoch before that await
    // observes the result proves the bound ingress epoch is the pre-await capture.
    let continueCalls = 0
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async () => {
          continueCalls += 1
          return planAction('pinload-race')
        },
      }),
    })
    host.controller.inhibitFeatureContinuation()
    const ingressEpoch = host.controller.featureContinuationEpoch()

    const running = host.commands.get('feature')?.handler('new #42', root)
    if (running === undefined) throw new Error('feature-command-unregistered')
    host.controller.inhibitFeatureContinuation()
    expect(host.controller.featureContinuationEpoch()).toBeGreaterThan(ingressEpoch)
    await running

    expect(continueCalls).toBe(1)
    expect(host.controller.featureContinuationInhibited()).toBe(true)
    expect(host.sent.some((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toBe(false)
  })
})
