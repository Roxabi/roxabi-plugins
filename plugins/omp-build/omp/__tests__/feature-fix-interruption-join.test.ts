import { afterEach, expect, it, vi } from 'vitest'
import type { NativePort } from '../../roxabi/fix-contract.ts'
import { startFixRun } from '../../roxabi/fix-entry-lifecycle.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { claimFixIngress, ownFixRun, releaseOwnedFixRun, reviewControllerFor } from '../omp-controller.ts'
import { featureWorkInterrupter } from '../omp-feature-session.ts'

afterEach(() => {
  vi.restoreAllMocks()
  cleanupFixtureActions()
})

async function ownedFix(stopError?: Error, nativeStop?: () => Promise<void>) {
  const api = createExtensionApiStub()
  if (nativeStop) {
    reviewControllerFor(api).activate(batch(['native-slot']), {
      onComplete: async () => {},
      onStop: nativeStop,
    })
  }
  const driver = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const fixBatch = batch(['fix-slot'])
  const native: NativePort = {
    active: () => null,
    activate: () => {},
    announce: async () => {},
    stopOwned: async () => {
      if (stopError) throw stopError
    },
  }
  const run = startFixRun({
    native,
    operations: {} as never,
    drive: async (_identity, runtime) => {
      runtime.onBatch(fixBatch)
      entered.resolve(runtime.signal)
      await driver.promise
      return { ok: false, diagnostics: ['fixture-driver-stopped'] }
    },
  })
  ownFixRun(api, { run, reporting: run.driverTerminated, release: release.promise })
  const signal = await entered.promise
  return { api, run, driver, release, signal }
}

async function nextTurn() {
  const turn = Promise.withResolvers<void>()
  setImmediate(turn.resolve)
  await turn.promise
}

it('joins native stop in parallel with the owned Fix driver and its exact host release', async () => {
  const nativeEntered = Promise.withResolvers<void>()
  const nativeRelease = Promise.withResolvers<void>()
  const f = await ownedFix(undefined, async () => {
    nativeEntered.resolve()
    await nativeRelease.promise
  })
  let settled = false
  const interruption = featureWorkInterrupter(f.api)('session-stop').finally(() => {
    settled = true
  })
  try {
    await nativeEntered.promise
    expect(f.signal.aborted).toBe(true)
    expect(settled).toBe(false)
    f.driver.resolve()
    await f.run.driverTerminated
    nativeRelease.resolve()
    await nextTurn()
    expect(settled).toBe(false)
    f.release.resolve()
    expect(await interruption).toEqual({ failures: [] })
  } finally {
    f.driver.resolve()
    nativeRelease.resolve()
    f.release.resolve()
    await Promise.allSettled([interruption])
    releaseOwnedFixRun(f.api, f.run)
  }
})

it('waits for native stop even after the Fix driver and host release finish', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = await ownedFix(undefined, async () => {
    entered.resolve()
    await release.promise
  })
  let settled = false
  const interruption = featureWorkInterrupter(f.api)('session-stop').finally(() => {
    settled = true
  })
  try {
    await entered.promise
    f.driver.resolve()
    await f.run.driverTerminated
    f.release.resolve()
    await nextTurn()
    expect(settled).toBe(false)
    release.resolve()
    expect(await interruption).toEqual({ failures: [] })
  } finally {
    f.driver.resolve()
    f.release.resolve()
    release.resolve()
    await Promise.allSettled([interruption])
    releaseOwnedFixRun(f.api, f.run)
  }
})

it('returns native joined failures after the Fix and host release settle', async () => {
  const failure = new Error('native-stop-failed')
  const f = await ownedFix(undefined, async () => {
    throw failure
  })
  const interruption = featureWorkInterrupter(f.api)('session-stop')
  try {
    f.driver.resolve()
    f.release.resolve()
    const result = await interruption
    expect(result.failures).toEqual([failure])
    expect(result.failures[0]).toBe(failure)
  } finally {
    f.driver.resolve()
    f.release.resolve()
    await Promise.allSettled([interruption])
    releaseOwnedFixRun(f.api, f.run)
  }
})

it('rejects on raw Fix stop failure and retains native joined failures', async () => {
  const fixFailure = new Error('fix-stop-failed')
  const nativeFailure = new Error('native-stop-failed')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = await ownedFix(fixFailure, async () => {
    throw nativeFailure
  })
  const interruption = featureWorkInterrupter(f.api)('session-stop')
  const outcome = interruption.catch((error: unknown) => error)
  try {
    f.driver.resolve()
    f.release.resolve()
    const error = await outcome
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([nativeFailure, fixFailure])
    expect((error as AggregateError).errors[0]).toBe(nativeFailure)
    expect((error as AggregateError).errors[1]).toBe(fixFailure)
    expect(log).toHaveBeenCalled()
  } finally {
    f.driver.resolve()
    f.release.resolve()
    await outcome
    releaseOwnedFixRun(f.api, f.run)
  }
})

it('rejects with the exact host release failure after the real Fix stops', async () => {
  const f = await ownedFix()
  const failure = new Error('host-release-failed')
  const interruption = featureWorkInterrupter(f.api)('session-stop')
  const outcome = interruption.catch((error: unknown) => error)
  try {
    f.driver.resolve()
    await f.run.driverTerminated
    f.release.reject(failure)
    expect(await outcome).toBe(failure)
  } finally {
    f.driver.resolve()
    f.release.resolve()
    await outcome
    releaseOwnedFixRun(f.api, f.run)
  }
})

it('holds interruption as unknown when Fix ingress is occupied but has no owned run', async () => {
  const api = createExtensionApiStub()
  const releaseIngress = claimFixIngress(api)
  try {
    await expect(featureWorkInterrupter(api)('session-stop')).rejects.toThrow('feature-fix-ingress-unjoined')
  } finally {
    releaseIngress()
  }
})
