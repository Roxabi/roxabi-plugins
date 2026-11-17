import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverFeatureResult } from '../../roxabi/feature-entry.ts'
import { announceFeatureBatch } from '../../roxabi/feature-host-native.ts'
import { rememberFeatureOwner } from '../../roxabi/feature-host-ownership.ts'
import {
  cleanup as cleanupFeatureHost,
  fixture as featureHostFixture,
  start as featureStart,
} from '../../testing/feature-host-native-interruption-fixture.ts'
import { nativeReviewChild } from '../../testing/native-review-child.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import type { NativeBatchResult } from '../review-runtime/contracts.ts'
import { createMaskFixture, owned } from './native-task-mask-fixture.ts'

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
  it.each([
    'normal',
    'abort',
    'foreign-owner',
    'abort-acquisition',
    'abort-after-send',
    'foreign-after-send',
    'root-after-send',
  ] as const)('preserves deferred feature ownership through a %s successor', async (mode) => {
    const f = fixture(false, false, false)
    const registration = vi.spyOn(f.harness.native, 'registerTool')
    installNativeBatchBridge(f.harness.native, f.harness.controller)
    const tool = registration.mock.calls
      .map(([definition]) => definition)
      .find((definition) => definition.name === owned)
    if (!tool) throw new Error('owned tool not registered')
    const execute = tool.execute as (...args: never[]) => Promise<unknown>
    const { host, published } = featureHostFixture(f.harness)
    host.native = f.port
    const successor = batch(['feature-successor'])
    host.workflow.continueFeature = async () => ({
      kind: 'action',
      node: 'plan',
      followUp: successor,
      start: featureStart(`successor-${mode}`),
    })
    adapter.capture.mockResolvedValue({ current: () => true })
    adapter.execute.mockImplementation(async (options) => {
      const task = options.batch.tasks.tasks[0]
      const id = task.name
      expect(options.bindChild(id, 0, { provider: 'fixture-provider', id: 'fixture-model' })).toBe(true)
      const sessionFile = join(tmpdir(), `feature-mask-child-${randomUUID()}.jsonl`)
      f.harness.native.events.emit('task:subagent:lifecycle', {
        status: 'started',
        id,
        agent: task.agent,
        index: 0,
        parentToolCallId: options.toolCallId,
        sessionFile,
        detached: false,
      })
      const child = await nativeReviewChild({ task, sessionFile })
      const input = { data: { findings: [] } }
      await child.call('yield', 'review-yield', input)
      await child.result('yield', 'review-yield', input, { content: [], details: {}, isError: false })
      return {
        results: [
          { index: 0, id, agent: task.agent, exitCode: 0, structuredOutput: { status: 'valid', data: input.data } },
        ],
        errors: [],
      }
    })
    await f.harness.emitBridge('session_start', {}, f.ctx)
    await announceFeatureBatch('#42', f.prepared, featureStart(`first-${mode}`), host, (next, current) =>
      deliverFeatureResult('#42', next, host, current),
    )
    expect(f.sends).toHaveLength(0)
    await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
    expect(f.sends).toHaveLength(1)
    await f.harness.emitBridge('agent_start', {}, f.ctx)
    const wire = f.harness.controller.wire(f.prepared)
    if (!wire) throw new Error('first feature not wired')
    const abort = new AbortController()
    await execute('feature-first' as never, wire as never, abort.signal as never, undefined as never, f.ctx as never)
    expect(published).toHaveLength(1)
    expect(f.harness.controller.active()).toBe(successor)
    expect(f.sends).toHaveLength(1)
    if (mode === 'abort') abort.abort()
    if (mode === 'foreign-owner')
      rememberFeatureOwner(host.key, { reference: '#foreign', cwd: host.cwd, pausable: true })
    async function endDuringAcquisition() {
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      if (mode === 'abort-acquisition') {
        f.session.runToolRegistryMutation.mockImplementationOnce(async (fn) => {
          entered.resolve()
          await resume.promise
          await fn()
        })
      }
      const ending = f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
      if (mode === 'abort-acquisition') {
        await entered.promise
        abort.abort()
        resume.resolve()
      }
      await ending
    }
    await endDuringAcquisition()
    const sent = mode === 'normal' || mode.endsWith('-after-send')
    expect(f.sends).toHaveLength(sent ? 2 : 1)
    expect(f.harness.controller.active()).toBe(sent ? successor : null)
    async function finishSent() {
      await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
      expect(f.sends).toHaveLength(2)
      expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
      const successorWire = f.harness.controller.wire(successor)
      if (!successorWire) throw new Error('successor not wired')
      const invalidateOwner = () => {
        if (mode === 'abort-after-send') abort.abort()
        if (mode === 'foreign-after-send')
          rememberFeatureOwner(host.key, { reference: '#foreign', cwd: host.cwd, pausable: true })
        if (mode === 'root-after-send') f.ctx.sessionManager.getSessionId = () => 'foreign-root'
      }
      invalidateOwner()
      if (mode === 'normal') {
        expect(f.harness.controller.admit(successor, 'feature-second', f.ctx as never, () => true)).toBe(true)
        f.harness.controller.finishExecution(successor)
        await f.port.stopOwned(successor, 'test-cleanup')
      } else {
        await expect(
          execute(
            'feature-second' as never,
            successorWire as never,
            new AbortController().signal as never,
            undefined as never,
            f.ctx as never,
          ),
        ).rejects.toThrow()
        expect(f.harness.controller.active()).toBeNull()
      }
    }
    if (sent) await finishSent()
  })

  it('refuses a non-local root without changing its tool presentation', async () => {
    const f = fixture(true)
    await f.start()
    sdk.get.mockReturnValue({ kind: 'main', session: { instanceKey: 'remote-fixture:1' } })
    await expect(f.port.announce(f.prepared)).rejects.toThrow('native task mask root unavailable')
    expect(f.sends).toEqual([])
    expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
  })

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

  it('masks and restores the moved root with stale registry file metadata', async () => {
    const f = fixture(true, true)
    f.ctx.cwd = '/moved-root'
    f.ctx.sessionManager.getCwd = () => '/moved-root'
    f.ctx.sessionManager.getSessionFile = () => '/moved-root/session.jsonl'
    await f.start()
    await f.port.announce(f.prepared)
    expect(f.sends).toEqual([{ active: ['read', owned], mounted: ['search'] }])
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, { ...f.ctx })
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['task', 'search'] })
  })

  it('does not restore when cached registry file metadata changes after capture', async () => {
    const f = fixture(true)
    f.ctx.sessionManager.getSessionFile = () => '/moved-root/session.jsonl'
    await f.start()
    await f.port.announce(f.prepared)
    f.ref.sessionFile = '/another/session.jsonl'
    await f.harness.emitBridge('session_stop', { signal: AbortSignal.abort() }, f.ctx).catch(() => undefined)
    expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
    expect(f.harness.controller.active()).toBeNull()
  })

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
      await expect(
        execute(
          'owned-call' as never,
          wire as never,
          new AbortController().signal as never,
          undefined as never,
          f.ctx as never,
        ),
      ).rejects.toThrow('native task mask restoration refused')
      const directory = join(
        f.ctx.localProtocolOptions.getArtifactsDir(),
        'local',
        'omp-build',
        'communication',
        'native-result',
      )
      const records = readdirSync(directory)
      expect(records).toHaveLength(1)
      const recordFile = records[0]
      if (!recordFile) throw new Error('Native result artifact missing')
      const retained = JSON.parse(readFileSync(join(directory, recordFile), 'utf8'))
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

  it('classifies an SDK-aborted terminal using the real owned-tool signal', async () => {
    const f = fixture(true)
    const registration = vi.spyOn(f.harness.native, 'registerTool')
    installNativeBatchBridge(f.harness.native, f.harness.controller)
    const tool = registration.mock.calls
      .map(([definition]) => definition)
      .find((definition) => definition.name === owned)
    if (!tool) throw new Error('owned tool not registered')
    adapter.capture.mockResolvedValue({ current: () => true })
    const abort = new AbortController()
    adapter.execute.mockImplementation(async (options) => {
      expect(options.bindChild('sdk-child', 0, { provider: 'fixture-provider', id: 'fixture-model' })).toBe(true)
      abort.abort()
      return {
        results: [{ id: 'sdk-child', index: 0, agent: 'R-review-adversarial', exitCode: 1, aborted: true }],
        errors: ['aborted'],
      }
    })
    await f.start()
    await f.port.announce(f.prepared)
    const wire = f.harness.controller.wire(f.prepared)
    if (!wire) throw new Error('batch not wired')
    const execute = tool.execute as (...args: never[]) => Promise<unknown>
    await execute('sdk-abort-call' as never, wire as never, abort.signal as never, undefined as never, f.ctx as never)
    await f.stoppedSignal.promise
    expect(f.stopFacts).toEqual([{ kind: 'unattributed', origin: 'sdk-abort' }])
    expect(f.completed).not.toHaveBeenCalled()
    expect(f.sends).toHaveLength(1)
  })

  it.each(['normal', 'abort-completion', 'abort-continuation', 'abort-acquisition'] as const)(
    'settles an owned handoff with %s',
    async (mode) => {
      const f = fixture(true, false, false)
      const registration = vi.spyOn(f.harness.native, 'registerTool')
      installNativeBatchBridge(f.harness.native, f.harness.controller)
      const tool = registration.mock.calls
        .map(([definition]) => definition)
        .find((definition) => definition.name === owned)
      if (!tool) throw new Error('owned tool not registered')
      const execute = tool.execute as (...args: never[]) => Promise<unknown>
      const successor = batch(['slot-b'])
      const events: string[] = []
      const successorCompleted = vi.fn(async () => {
        events.push('successor-complete')
      })
      const completionEntered = Promise.withResolvers<void>()
      const finishCompletion = Promise.withResolvers<void>()
      const continuationEntered = Promise.withResolvers<void>()
      const finishContinuation = Promise.withResolvers<void>()
      const acquisitionEntered = Promise.withResolvers<void>()
      const finishAcquisition = Promise.withResolvers<void>()
      f.completed.mockImplementation(async () => {
        events.push('predecessor-receipt')
        completionEntered.resolve()
        await finishCompletion.promise
      })
      f.settled.mockImplementation(async (_result: NativeBatchResult, canContinue: () => boolean) => {
        continuationEntered.resolve()
        await finishContinuation.promise
        if (!canContinue()) return
        f.port.activate(successor, {
          onComplete: successorCompleted,
          onStop: async () => {
            events.push('successor-stop')
          },
        })
        if (mode === 'abort-acquisition') {
          f.session.runToolRegistryMutation.mockImplementationOnce(async (fn) => {
            acquisitionEntered.resolve()
            await finishAcquisition.promise
            await fn()
          })
        }
        await f.port.announce(successor, canContinue)
        if (!canContinue()) return
        events.push('successor-announced')
      })
      adapter.capture.mockResolvedValue({ current: () => true })
      adapter.execute.mockImplementation(async (options) => {
        const task = options.batch.tasks.tasks[0]
        const id = task.name
        expect(options.bindChild(id, 0, { provider: 'fixture-provider', id: 'fixture-model' })).toBe(true)
        const sessionFile = join(tmpdir(), `mask-child-${randomUUID()}.jsonl`)
        f.harness.native.events.emit('task:subagent:lifecycle', {
          status: 'started',
          id,
          agent: task.agent,
          index: 0,
          parentToolCallId: options.toolCallId,
          sessionFile,
          detached: false,
        })
        const child = await nativeReviewChild({ task, sessionFile })
        const input = { data: { findings: [] } }
        await child.call('yield', 'review-yield', input)
        await child.result('yield', 'review-yield', input, { content: [], details: {}, isError: false })
        return {
          results: [
            { index: 0, id, agent: task.agent, exitCode: 0, structuredOutput: { status: 'valid', data: input.data } },
          ],
          errors: [],
        }
      })
      await f.start()
      await f.port.announce(f.prepared)
      const firstWire = f.harness.controller.wire(f.prepared)
      if (!firstWire) throw new Error('predecessor not wired')
      const abort = new AbortController()
      const first = execute(
        'first-call' as never,
        firstWire as never,
        abort.signal as never,
        undefined as never,
        f.ctx as never,
      )
      async function settlePredecessor() {
        await completionEntered.promise
        expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
        if (mode === 'abort-completion') abort.abort()
        finishCompletion.resolve()
        if (mode !== 'abort-completion') {
          await continuationEntered.promise
          if (mode === 'abort-continuation') abort.abort()
          finishContinuation.resolve()
        }
        if (mode === 'abort-acquisition') {
          await acquisitionEntered.promise
          expect(f.harness.controller.active()).toBe(successor)
          abort.abort()
          finishAcquisition.resolve()
        }
        await first
      }
      await settlePredecessor()
      if (mode !== 'normal') {
        expect(events).toEqual(
          mode === 'abort-acquisition' ? ['predecessor-receipt', 'successor-stop'] : ['predecessor-receipt'],
        )
        expect(f.completed).toHaveBeenCalledTimes(1)
        expect(f.settled).toHaveBeenCalledTimes(mode === 'abort-completion' ? 0 : 1)
        expect(f.stopped).toEqual([])
        expect(f.sends).toHaveLength(1)
        return
      }
      expect(events).toEqual(['predecessor-receipt', 'successor-announced'])
      expect(f.completed).toHaveBeenCalledTimes(1)
      expect(f.sends).toHaveLength(2)
      expect(f.harness.controller.active()).toBe(successor)
      await f.harness.emitBridge('agent_end', { willContinue: false }, f.ctx)
      expect(f.surface()).toEqual({ active: ['read', owned], mounted: ['search'] })
      const secondWire = f.harness.controller.wire(successor)
      if (!secondWire) throw new Error('successor not wired')
      await execute(
        'second-call' as never,
        secondWire as never,
        new AbortController().signal as never,
        undefined as never,
        f.ctx as never,
      )
      expect(successorCompleted).toHaveBeenCalledTimes(1)
      expect(events).toEqual(['predecessor-receipt', 'successor-announced', 'successor-complete'])
      expect(f.harness.controller.active()).toBeNull()
      expect(f.surface()).toEqual({ active: ['read', 'task', owned], mounted: ['search'] })
    },
  )
})
