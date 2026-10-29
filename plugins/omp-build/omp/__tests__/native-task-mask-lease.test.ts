import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import type { NativeBatchResult } from '../review-runtime/contracts.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'

// Only the public registry/session boundary is simulated; no child lifecycle is fabricated.
const sdk = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@oh-my-pi/pi-coding-agent/registry/agent-registry', () => ({
  AgentRegistry: { global: () => ({ get: sdk.get, onChange: () => () => undefined }) },
}))
const adapter = vi.hoisted(() => ({ execute: vi.fn(), capture: vi.fn() }))
vi.mock('../review-runtime/native-sdk-adapter.ts', () => ({
  executeNativeBatch: adapter.execute,
  captureNativeRoot: adapter.capture,
}))

const owned = 'omp_build_execute_native_batch'

afterEach(() => {
  cleanupFixtureActions()
  sdk.get.mockReset()
  adapter.execute.mockReset()
  adapter.capture.mockReset()
})

function fixture(idle: boolean, taskMounted = false) {
  const harness = bridgeHarness()
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
  const completed = vi.fn()
  const stoppedSignal = Promise.withResolvers<void>()
  const port = createNativeReviewPort(harness.native, harness.controller)
  const start = async () => {
    await harness.emitBridge('session_start', {}, ctx)
    port.activate(prepared, {
      onComplete: completed,
      onStop: async (reason, result) => {
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
    stoppedSignal,
    completed,
    surface: () => ({ active: [...active], mounted: [...mounted] }),
    replaceSurface: (a: string[], m: string[]) => {
      active = [...a]
      mounted = [...m]
    },
  }
}

describe('scoped native dispatch tool mask', () => {
  it.each(['idle', 'agent-end', 'late'] as const)(
    'masks task before the %s control send and restores the unchanged partition',
    async (path) => {
      const f = fixture(path === 'idle', true)
      await f.start()
      if (path === 'late') await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
      await f.port.announce(f.prepared)
      if (path === 'agent-end') {
        expect(f.sends).toEqual([])
        expect(f.surface().mounted).toContain('task')
        await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
      }
      expect(f.sends).toEqual([
        {
          active: ['read', owned],
          mounted: ['search'],
        },
      ])
      await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx)
      expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['task', 'search'] })
    },
  )

  it('refuses to send instead of enabling a user-disabled owned tool', async () => {
    const f = fixture(true)
    f.replaceSurface(['read', 'task'], ['search'])
    await f.start()
    await expect(f.port.announce(f.prepared)).rejects.toThrow('native dispatch tool is not enabled')
    expect(f.sends).toEqual([])
    expect(f.surface()).toEqual({ active: ['read', 'task'], mounted: ['search'] })
    expect(f.harness.controller.active()).toBeNull()
  })

  it('refuses to mask a tool named task when it is not the SDK builtin', async () => {
    const f = fixture(true)
    f.session.hasBuiltInTool = () => false
    await f.start()
    await expect(f.port.announce(f.prepared)).rejects.toThrow()
    expect(f.sends).toEqual([])
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })

  it('preserves an externally changed surface and stops rather than restoring over it', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    f.replaceSurface(['read', owned, 'external'], ['search'])
    await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx).catch(() => undefined)
    expect(f.surface()).toEqual({ active: ['read', owned, 'external'], mounted: ['search'] })
    expect(f.harness.controller.active()).toBeNull()
  })

  it.each(['drift', 'verification exception'] as const)(
    'retains actual execution results and fails settlement on post-execution %s',
    async (mode) => {
      const f = fixture(true)
      const registration = vi.spyOn(f.harness.native, 'registerTool')
      installNativeBatchBridge(f.harness.native, f.harness.controller)
      const tool = registration.mock.calls
        .map(([definition]) => definition)
        .find((definition) => definition.name === owned)
      if (!tool) throw new Error('owned tool not registered')
      const actual = {
        id: 'observed-child',
        index: 0,
        agent: 'R-review-adversarial',
        exitCode: 0,
        output: 'actual result',
      }
      adapter.capture.mockResolvedValue({ current: () => true })
      adapter.execute.mockImplementation(async () => {
        if (mode === 'drift') f.replaceSurface(['read', owned, 'external'], ['search'])
        else
          f.session.getActiveToolNames = () => {
            throw new Error('surface unavailable')
          }
        return { results: [actual], errors: [] }
      })
      await f.start()
      await f.port.announce(f.prepared)
      const wire = f.harness.controller.wire(f.prepared)
      if (!wire) throw new Error('batch not wired')
      const execute = tool.execute as (
        ...args: never[]
      ) => Promise<{ isError: boolean; details: { detailRef: string; childIds: string[] } }>
      const result = await execute(
        'owned-call' as never,
        wire as never,
        new AbortController().signal as never,
        undefined as never,
        f.ctx as never,
      )
      expect(result.isError).toBe(true)
      expect(result.details.childIds).toEqual(['observed-child'])
      expect(result.details.detailRef).toMatch(/^local:\/\//)
      const retained = JSON.parse(
        readFileSync(
          join(
            f.ctx.localProtocolOptions.getArtifactsDir(),
            'local',
            result.details.detailRef.slice('local://'.length),
          ),
          'utf8',
        ),
      )
      expect(retained.results).toEqual([actual])
      expect(retained.errors).toEqual([
        expect.stringContaining(
          mode === 'drift' ? 'mask drifted during execution' : 'mask verification failed: surface unavailable',
        ),
      ])
      await f.stoppedSignal.promise
      expect(f.completed).not.toHaveBeenCalled()
      expect(f.stoppedResults[0]).toMatchObject({
        complete: false,
        raw: { results: [actual], errors: retained.errors },
      })
    },
  )

  it.each(['journal', 'provider', 'cwd', 'ref'] as const)(
    'does not restore into a changed %s identity',
    async (identity) => {
      const f = fixture(true)
      await f.start()
      await f.port.announce(f.prepared)
      if (identity === 'journal') f.ctx.sessionManager.getSessionId = () => 'other'
      if (identity === 'provider') f.session.agent.sessionId = 'other'
      if (identity === 'cwd') f.ctx.cwd = '/elsewhere'
      if (identity === 'ref') sdk.get.mockReturnValue({ ...f.ref })
      await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx).catch(() => undefined)
      expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    },
  )

  it('restores and stops when the control send throws synchronously', async () => {
    const f = fixture(true)
    await f.start()
    vi.mocked(f.harness.native.sendMessage).mockImplementation(() => {
      throw new Error('send failed')
    })
    await expect(f.port.announce(f.prepared)).rejects.toThrow('send failed')
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
    expect(f.harness.controller.active()).toBeNull()
  })

  it('does not send after cancellation while the SDK mutation queue is blocked', async () => {
    const f = fixture(true)
    await f.start()
    const entered = Promise.withResolvers<void>()
    const unblock = Promise.withResolvers<void>()
    f.session.runToolRegistryMutation.mockImplementationOnce(async (fn) => {
      entered.resolve()
      await unblock.promise
      await fn()
    })
    const announcement = f.port.announce(f.prepared)
    await entered.promise
    const stop = f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx)
    unblock.resolve()
    await announcement.catch(() => undefined)
    await stop
    expect(f.sends).toEqual([])
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
    expect(f.harness.controller.active()).toBeNull()
  })

  it('keeps the mask for a continuing owned action, then restores on terminal agent end', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    await f.harness.emitBridge('agent_end', { willContinue: true }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })

  it('does not retain a completed batch mask for unrelated continuing work', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    f.harness.controller.inactive()
    await f.harness.emitBridge('agent_end', { willContinue: true }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })

  it('releases the old batch before a successor send and ignores a stale batch stop', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    f.harness.controller.inactive()
    await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
    const successor = batch(['slot-b'])
    f.port.activate(successor, { onComplete: async () => undefined, onStop: async () => undefined })
    await f.port.announce(successor)
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    await f.port.stopOwned(f.prepared, 'stale')
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    expect(f.harness.controller.active()).toBe(successor)
  })

  it('restores the original partition during the same-root pre-switch transition', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    f.session.isSessionTransitioning = true
    await f.harness.emitBridge('session_before_switch', {}, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })
})
