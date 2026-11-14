import { afterEach, expect, it } from 'vitest'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry.ts'
import { ownedFeatureFor } from '../../roxabi/feature-host-ownership.ts'
import { startDispatch } from '../../roxabi/feature-start-executions.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { cleanup, implementationBatch, start } from '../../testing/feature-host-native-interruption-fixture.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { reviewControllerFor } from '../omp-controller.ts'
import { createFeatureCommandHost } from '../omp-feature-command-host.ts'
import {
  beginFeatureUwIntake,
  createFeatureOperationReportGuard,
  installFeatureUwOperationLifecycle,
} from '../omp-feature-composition.ts'
import { createOperatorConfirmation } from '../omp-operator-confirmation.ts'

afterEach(cleanup)

it('cannot dispatch an old implementation after session replacement and a move-only command', async () => {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const messages: unknown[] = []
  const pi = createExtensionApiStub({
    on(name, listener) {
      const existing = listeners.get(name) ?? []
      existing.push(listener as never)
      listeners.set(name, existing)
    },
    sendMessage(message) {
      messages.push(message)
    },
  })
  installFeatureUwOperationLifecycle(pi)
  let session = 'origin-A'
  const base = consultableAgentRoot()
  const artifacts = base.localProtocolOptions.getArtifactsDir()
  const ctx = {
    ...base,
    cwd: '/workspace',
    localProtocolOptions: { getArtifactsDir: () => artifacts },
    sessionManager: {
      getSessionId: () => session,
      getCwd: () => '/workspace',
      getSessionFile: () => '/workspace/session.jsonl',
      getArtifactsDir: () => artifacts,
    },
  }
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx as never)
  const prepared = implementationBatch()
  const ref = start('origin-race-start')
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<{ stdout: string; exitCode: number }>()
  const workflow = {
    async continueFeature(input: { reference: string }) {
      return input.reference === '42'
        ? { kind: 'action' as const, node: 'implement' as const, followUp: prepared, start: ref }
        : { kind: 'session-cwd' as const, path: '/workspace', instruction: '/move /workspace' }
    },
    async consumeWatchExit() {
      return { kind: 'blocked' as const, reason: 'unexpected' }
    },
    async publishFeatureNativeResult() {
      throw new Error('unexpected publication')
    },
    async requestFeatureSessionPause() {
      return { kind: 'paused' as const, confirmed: false, reason: 'unconfirmed' }
    },
  }
  const composition = {
    pi,
    options: { principalCwd: () => false },
    interruptOwnedFeatureWork: async () => {},
    framing: {},
  } as never
  const operatorA = createOperatorConfirmation(ctx as never)
  const reportA = createFeatureOperationReportGuard(pi, ctx as never, operatorA)
  beginFeatureUwIntake(pi, operatorA, ctx as never)
  const hostA = createFeatureCommandHost(
    composition,
    { ctx: ctx as never, operator: operatorA, originalArgs: '#42' },
    workflow,
    controller,
    undefined,
    reportA,
  )
  hostA.git = async () => {
    entered.resolve()
    return gate.promise
  }
  const oldCommand = runInstalledFeatureCommand('#42', hostA)
  await entered.promise
  session = 'origin-B'
  for (const listener of listeners.get('session_switch') ?? []) await listener({} as never, ctx as never)
  controller.inhibitFeatureContinuation()
  controller.observeRootContext(ctx as never)
  const operatorB = createOperatorConfirmation(ctx as never)
  const reportB = createFeatureOperationReportGuard(pi, ctx as never, operatorB)
  beginFeatureUwIntake(pi, operatorB, ctx as never)
  const hostB = createFeatureCommandHost(
    composition,
    { ctx: ctx as never, operator: operatorB, originalArgs: '#43' },
    workflow,
    controller,
    undefined,
    reportB,
  )
  await runInstalledFeatureCommand('#43', hostB)
  expect(controller.featureContinuationInhibited()).toBe(false)
  expect(ownedFeatureFor(pi)).toBeUndefined()
  gate.resolve({ stdout: 'a'.repeat(40), exitCode: 0 })
  await oldCommand
  expect(controller.active()).toBeNull()
  expect(ownedFeatureFor(pi)).toBeUndefined()
  expect(startDispatch(ref)).toEqual({ kind: 'not-activated' })
  expect(messages.some((message) => JSON.stringify(message).includes('OMP_BUILD_NATIVE_BATCH'))).toBe(false)
})
