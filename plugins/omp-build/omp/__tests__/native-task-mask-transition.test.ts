import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup as cleanupFeatureHost } from '../../testing/feature-host-native-interruption-fixture.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { createMaskFixture, owned } from './native-task-mask-fixture.ts'

const sdk = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@oh-my-pi/pi-coding-agent/registry/agent-registry', () => ({
  AgentRegistry: { global: () => ({ get: sdk.get, onChange: () => () => undefined }) },
}))
const adapter = vi.hoisted(() => ({ execute: vi.fn(), capture: vi.fn() }))
vi.mock('../review-runtime/native-sdk-adapter.ts', () => ({
  executeNativeBatch: adapter.execute,
  captureNativeRoot: adapter.capture,
}))

afterEach(() => {
  cleanupFixtureActions()
  cleanupFeatureHost()
  sdk.get.mockReset()
  adapter.execute.mockReset()
  adapter.capture.mockReset()
})
const fixture = (idle: boolean, taskMounted = false, install = true) =>
  createMaskFixture(sdk, idle, taskMounted, install)

describe('scoped native dispatch tool mask', () => {
  it.each(['journal', 'file', 'provider', 'cwd', 'ref', 'session', 'modelRegistry', 'costGate'] as const)(
    'does not restore into a changed %s identity',
    async (identity) => {
      const f = fixture(true)
      Reflect.set(f.session, 'costGate', { generation: 1 })
      await f.start()
      await f.port.announce(f.prepared)
      const changes = {
        journal: () => {
          f.ctx.sessionManager.getSessionId = () => 'other'
        },
        file: () => {
          f.ctx.sessionManager.getSessionFile = () => '/elsewhere/session.jsonl'
        },
        provider: () => {
          f.session.agent.sessionId = 'other'
        },
        cwd: () => {
          f.ctx.cwd = '/elsewhere'
        },
        ref: () => {
          sdk.get.mockReturnValue({ ...f.ref })
        },
        session: () => {
          f.ref.session = { ...f.session }
        },
        modelRegistry: () => {
          f.ctx.modelRegistry = f.session.modelRegistry = {}
        },
        costGate: () => {
          Reflect.set(f.session, 'costGate', { generation: 2 })
        },
      }
      changes[identity]()
      await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx).catch(() => undefined)
      expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    },
  )

  it('restores when the captured cost gate changes internally without replacement', async () => {
    const f = fixture(true)
    const gate = { generation: 1 }
    Reflect.set(f.session, 'costGate', gate)
    await f.start()
    await f.port.announce(f.prepared)
    gate.generation = 2
    await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })

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

  it('keeps the mask until the owned action is stopped, including across agent ends', async () => {
    const f = fixture(true)
    await f.start()
    await f.port.announce(f.prepared)
    await f.harness.emitBridge('agent_end', { willContinue: true }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    await f.port.stopOwned(f.prepared, 'test-stop')
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
