import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { arrangeReviewFixture, REVIEW_SCOPE, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { cleanupNativeRoots, provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { readSim } from '../../testing/sandbox/sandbox-repository.ts'
import { claimFixIngress, reviewControllerFor } from '../omp-controller.ts'
import { dispatchAdmittedCiCorrection, dispatchDefaultFix } from '../omp-fix-dispatch.ts'
import { registerOmpFixRecoveryTool } from '../omp-fix-recovery.ts'
import { captureNativeRootLifetime } from '../review-runtime/native-sdk-adapter.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

const roots = new Set<string>()
afterEach(() => {
  cleanupFixtureActions()
  cleanupNativeRoots()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses correction and recovery before publishing while an admitted non-Fix batch is running', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const reader = createInstalledUwReadPort({
    cwd,
    readAuthor: 'operator',
    gh: async (dir, args) => execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' }),
  })
  const observed = await reader.readUw(REVIEW_SCOPE)
  if (observed.accepted.status !== 'accepted') throw new Error('fixture-accepted-uw-missing')
  let recover: ((ctx: unknown) => Promise<unknown>) | undefined
  const api = createExtensionApiStub({
    registerTool: (definition) => {
      if (definition.name === 'omp_build_recover_interrupted_fix') {
        recover = (ctx) => definition.execute('recovery-call', { pr: 7 } as never, undefined, undefined, ctx as never)
      }
    },
  })
  registerOmpFixRecoveryTool(api)
  if (!recover) throw new Error('recovery tool not registered')
  const ctx = {
    agent: { kind: 'main' as const, id: 'ForeignWriterRoot', name: 'main', depth: 0 },
    cwd,
    sessionManager: { getSessionId: () => 'foreign-writer-session' },
    isIdle: () => true,
  }
  provisionNativeRoot(ctx)
  const root = await captureNativeRootLifetime(ctx as never)
  if (!root) throw new Error('fixture root lifetime was not captured')
  const controller = reviewControllerFor(api)
  controller.observeRootContext(ctx as never)
  const port = createNativeReviewPort(api, controller)
  const writer = batch(['review-writer'])
  port.activate(writer, { onComplete: async () => {}, onStop: async () => {} })
  await port.announce(writer)
  expect(controller.admit(writer, 'review-call', ctx as never, root.current)).toBe(true)
  const before = readSim(box)
  try {
    await expect(dispatchDefaultFix(api, ctx as never, '#7')).rejects.toThrow('fix-known-native-writer-active')
    await expect(
      dispatchAdmittedCiCorrection(api, ctx as never, {
        reference: '#7',
        attributionRecordId: 'fixture-attribution',
        uw: { ownSpec: observed.accepted.value, children: [] },
      }),
    ).rejects.toThrow('fix-known-native-writer-active')
    await expect(recover(ctx)).rejects.toThrow('fix-known-native-writer-active')
    const after = readSim(box)
    expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
    expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
    expect(controller.active()).toBe(writer)
  } finally {
    controller.finishExecution(writer)
    await controller.stopOwned(writer, 'test-cleanup')
  }
  const release = claimFixIngress(api)
  release()
})

it('refuses Fix ingress until a foreign native batch has actually settled', async () => {
  const api = createExtensionApiStub()
  const controller = reviewControllerFor(api)
  const writer = batch(['review-settling'])
  const entered = Promise.withResolvers<void>()
  const releaseStop = Promise.withResolvers<void>()
  controller.activate(writer, {
    onComplete: async () => {},
    onStop: async () => {
      entered.resolve()
      await releaseStop.promise
    },
  })
  const stopped = controller.stopOwned(writer, 'stop-review')
  try {
    await entered.promise
    expect(() => claimFixIngress(api)).toThrow('fix-known-native-writer-active')
  } finally {
    releaseStop.resolve()
    await stopped
  }
  const release = claimFixIngress(api)
  release()
})

it('refuses a foreign native activation while Fix ingress is held', async () => {
  const api = createExtensionApiStub()
  const controller = reviewControllerFor(api)
  const writer = batch(['review-after-fix-ingress'])
  const callbacks = { onComplete: async () => {}, onStop: async () => {} }
  const release = claimFixIngress(api)
  try {
    expect(() => controller.activate(writer, callbacks)).toThrow('fix-run-already-active')
    expect(controller.active()).toBeNull()
  } finally {
    release()
  }
  controller.activate(writer, callbacks)
  expect(controller.active()).toBe(writer)
  await controller.stopOwned(writer, 'test-cleanup')
})
