import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import { isLocalAgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session-handle'
import { expect, it } from 'vitest'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub, type ExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { reviewControllerFor } from '../omp-controller.ts'
import { installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import { registerUwCommand } from '../omp-uw-command.ts'
import type { NativeStop } from '../review-runtime/contracts.ts'

type Command = Parameters<ExtensionApiStub['registerCommand']>[1]
type SessionListener = (event: Record<string, never>, context: ExtensionContext) => unknown

it('announces a sister assessment and revokes its native selector on root session switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uw-cause-command-'))
  const requestFile = join(directory, 'request.json')
  const target = { repository: 'acme/widgets', target: 'acme/widgets#42' }
  const parent = { repository: target.repository, target: 'acme/widgets#7' }
  const ownedTool = 'omp_build_execute_native_batch'
  writeFileSync(
    requestFile,
    JSON.stringify({
      disposition: { scope: target, recordId: 'cause', kind: 'cause-disposition' },
      factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
      tierOverride: null,
      labels: { add: [], remove: [] },
      parentCoverage: {
        parent: { uw: parent, version: 'a'.repeat(64) },
        assignments: [{ criterion: 'C1', children: [{ kind: 'created-child' }] }],
      },
    }),
  )
  const commands = new Map<string, Command>()
  const listeners = new Map<string, SessionListener[]>()
  const messages: Parameters<ExtensionApiStub['sendMessage']>[] = []
  const stops: NativeStop[] = []
  const done = Promise.withResolvers<void>()
  const state: { signal?: AbortSignal } = {}
  let executeNative: ((batchId: string) => Promise<unknown>) | undefined
  const operatorRoot = operatorRootContext(directory, consultableProtocolOptions())
  const root = {
    ...operatorRoot,
    sessionManager: { ...operatorRoot.sessionManager, getSessionFile: () => join(directory, 'session.jsonl') },
    hasUI: true,
    mode: 'tui',
    isIdle: () => true,
    ui: operatorDialogUi(async () => 'confirm'),
  }
  const context = root as unknown as Parameters<Command['handler']>[1]
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler as unknown as SessionListener])
    },
    registerCommand: (name, command) => {
      commands.set(name, command)
    },
    registerTool: (tool) => {
      if (tool.name === ownedTool) {
        executeNative = async (batchId) =>
          tool.execute(
            'uw-assessment-call',
            { batchId } as Parameters<typeof tool.execute>[1],
            undefined,
            undefined,
            context,
          )
      }
    },
    sendMessage: (...args) => {
      messages.push(args)
    },
  })
  const emitSession = async (event: 'session_start' | 'session_switch') => {
    for (const listener of listeners.get(event) ?? []) await listener({}, context)
  }
  try {
    provisionNativeRoot(root)
    const session = AgentRegistry.global().get(root.agent.id)?.session
    if (!session || !isLocalAgentSession(session)) throw new Error('native-root-fixture-missing')
    const initialTools = session.getActiveToolNames()
    expect(initialTools).toContain('task')

    reviewControllerFor(pi)
    installFeatureUwOperationLifecycle(pi)
    // Substitute the Roxabi product at its operation port; the native host, bridge, and tool are real.
    registerUwCommand(pi, ({ nativeHost }) => ({
      ...fixtureUwOperations(),
      createSister: async () => {
        if (nativeHost === undefined) throw new Error('missing native host')
        state.signal = nativeHost.signal
        const prepared = batch(['slot-a'])
        nativeHost.native.activate(prepared, {
          onComplete: async () => {
            throw new Error('unexpected assessment completion')
          },
          onStop: async (_reason, _result, stop) => {
            stops.push(stop)
          },
        })
        nativeHost.onBatch(prepared)
        await nativeHost.native.announce(prepared)
        nativeHost.onStarted({
          creationOperationId: 'create-1',
          assessmentStart: { scope: parent, recordId: 'assessment-start', kind: 'action-receipt' },
        })
        await done.promise
        return { status: 'refused', diagnostics: [] }
      },
    }))
    await emitSession('session_start')
    const command = commands.get('uw')
    if (command === undefined || executeNative === undefined) throw new Error('UW command or native tool missing')
    await command.handler(`sister --request-file ${requestFile}`, context)

    expect(messages).toEqual([
      [
        {
          customType: 'omp-build-native-batch',
          display: false,
          content: expect.stringContaining('OMP_BUILD_NATIVE_BATCH:\n'),
        },
        { triggerTurn: true },
      ],
      [
        expect.stringMatching(/^uw-assessment-started: \S+ create-1 acme\/widgets#7 assessment-start$/),
        { triggerTurn: false },
      ],
    ])
    const announcement = messages[0]?.[0]
    if (!announcement || typeof announcement === 'string' || typeof announcement.content !== 'string') {
      throw new Error('native batch control message missing')
    }
    const wire: unknown = JSON.parse(announcement.content.split('\n')[1] ?? '')
    expect(wire).toEqual({ batchId: expect.any(String) })
    if (!wire || typeof wire !== 'object' || !('batchId' in wire) || typeof wire.batchId !== 'string') {
      throw new Error('native batch selector missing')
    }
    expect(session.getActiveToolNames()).toContain(ownedTool)
    expect(session.getActiveToolNames()).not.toContain('task')
    await expect(executeNative(`forged-${wire.batchId}`)).rejects.toThrow('not the active authorized action')
    expect(state.signal?.aborted).toBe(false)
    expect(stops).toEqual([])

    await emitSession('session_switch')
    expect(state.signal?.aborted).toBe(true)
    expect(stops).toEqual([{ kind: 'interrupted', origin: 'host-stop', proof: 'not-dispatched' }])
    expect(session.getActiveToolNames()).toEqual(initialTools)
    await expect(executeNative(wire.batchId)).rejects.toThrow('not the active authorized action')
    done.resolve()
    await setImmediate()
    expect(messages).toHaveLength(2)
  } finally {
    try {
      await emitSession('session_switch')
    } finally {
      done.resolve()
      cleanupFixtureActions()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
