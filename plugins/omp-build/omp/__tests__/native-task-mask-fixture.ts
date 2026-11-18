import { type Mock, vi } from 'vitest'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness } from '../../testing/review-runtime-support.ts'
import type { NativeBatchResult, NativeStop } from '../review-runtime/contracts.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

export const owned = 'omp_build_execute_native_batch'

export function createMaskFixture(sdk: { get: Mock }, idle: boolean, taskMounted = false, install = true) {
  const harness = bridgeHarness(install)
  const prepared = batch(['slot-a'])
  let active = taskMounted ? ['read', owned] : ['read', 'task', owned]
  let mounted = taskMounted ? ['task', 'search'] : ['search']
  const manager = {
    getSessionId: () => 'journal',
    getSessionFile: () => '/fixture/session.jsonl',
    getCwd: () => '/fixture-root',
  }
  const modelRegistry = {}
  const session = {
    hasBuiltInTool: (name: string): boolean => name === 'task',
    registerSessionChangeCallback: () => () => undefined,
    sessionManager: manager,
    modelRegistry,
    agent: { sessionId: 'provider' },
    isDisposed: false,
    isSessionTransitioning: false,
    getActiveToolNames: () => [...active],
    getMountedXdevToolNames: () => [...mounted],
    getEnabledToolNames: () => [...active, ...mounted],
    runToolRegistryMutation: vi.fn(async (fn: () => Promise<void>) => await fn()),
    setActiveToolPresentation: vi.fn(async (enabled: string[], nextMounted: string[]) => {
      mounted = [...nextMounted]
      active = enabled.filter((name) => !mounted.includes(name))
    }),
  }
  const ref = { kind: 'main', session, sessionFile: manager.getSessionFile() }
  sdk.get.mockReturnValue(ref)
  const model = { id: 'fixture-model', provider: 'fixture-provider' }
  const ctx = {
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    cwd: '/fixture-root',
    sessionManager: manager,
    modelRegistry,
    model,
    localProtocolOptions: consultableProtocolOptions(),
    models: { resolve: () => model, current: () => model },
    isIdle: () => idle,
  }
  const sends: Array<{ active: string[]; mounted: string[] }> = []
  vi.spyOn(harness.native, 'sendMessage').mockImplementation(() => {
    sends.push({ active: [...active], mounted: [...mounted] })
  })
  const stopped: string[] = []
  const stoppedResults: Array<NativeBatchResult | null> = []
  const stopFacts: NativeStop[] = []
  const completed = vi.fn()
  const settled = vi.fn()
  const stoppedSignal = Promise.withResolvers<void>()
  const port = createNativeReviewPort(harness.native, harness.controller)
  const start = async () => {
    await harness.emitBridge('session_start', {}, ctx)
    port.activate(prepared, {
      onComplete: completed,
      onSettled: settled,
      onStop: async (reason, result, stop) => {
        stopFacts.push(stop)
        stopped.push(reason)
        stoppedResults.push(result)
        stoppedSignal.resolve()
      },
    })
  }
  return {
    harness,
    prepared,
    port,
    start,
    ctx,
    session,
    ref,
    sends,
    stopped,
    stoppedResults,
    stopFacts,
    stoppedSignal,
    completed,
    settled,
    surface: () => ({ active: [...active], mounted: [...mounted] }),
    replaceSurface: (a: string[], m: string[]) => {
      active = [...a]
      mounted = [...m]
    },
  }
}
