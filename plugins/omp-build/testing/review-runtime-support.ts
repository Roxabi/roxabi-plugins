import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionInputDigest } from '../engine/action-input.ts'
import { registerHostActionBinding } from '../omp/review-runtime/action-registry.ts'
import { installNativeBatchBridge } from '../omp/review-runtime/bridge.ts'
import type { NativeBatch, NativeExtension } from '../omp/review-runtime/contracts.ts'
import { NativeBatchController } from '../omp/review-runtime/controller.ts'
import type { PreparedUwAction } from '../roxabi/uw-action-contract.ts'
import { sealActionSnapshot } from '../roxabi/uw-action-snapshot.ts'
import { standaloneReviewInputs } from './action-input-fixtures.ts'
import { createExtensionApiStub, type ExtensionApiStub } from './extension-api-stub.ts'
import { type NativeReviewChild, nativeReviewChild } from './native-review-child.ts'
import { provisionUnitSdkRoot } from './unit-sdk-scopes.ts'

function userMessageText(content: Parameters<ExtensionApiStub['sendUserMessage']>[0]): string {
  if (typeof content === 'string') return content
  return content.reduce((text, block) => (block.type === 'text' ? text + block.text : text), '')
}

type RegisteredHandler = (...args: never[]) => unknown

export type BridgeHarness = {
  controller: NativeBatchController
  native: NativeExtension
  messages: string[]
  emitBridge(event: string, ...args: unknown[]): Promise<unknown>
  emitBridgeAndSettle(event: string, ...args: unknown[]): Promise<unknown>
  emitRaw(value: unknown): void
  admitChild(
    prepared: NativeBatch,
    logicalName: string,
    allocatedId?: string,
    options?: { toolCallId?: string; root?: Record<string, unknown>; skipRootCall?: boolean },
  ): Promise<NativeReviewChild>
  yieldChild(allocatedId: string, data: unknown, options?: { toolCallId?: string }): Promise<void>
}

export const root = { agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 } }

export function bridgeHarness(): BridgeHarness {
  const handlers = new Map<string, RegisteredHandler[]>()
  const children = new Map<string, NativeReviewChild>()
  let admittedCall: string | null = null
  let admittedBatch: NativeBatch | null = null
  const startedRoots = new WeakSet<object>()
  const messages: string[] = []
  const rawHandlers = new Map<string, Array<(value: unknown) => void>>()
  const emitRawChannel = (channel: string, value: unknown) => {
    for (const handler of rawHandlers.get(channel) ?? []) handler(value)
  }
  const native: NativeExtension = createExtensionApiStub({
    events: {
      on: (channel, handler) => {
        rawHandlers.set(channel, [...(rawHandlers.get(channel) ?? []), handler])
        return () => {
          rawHandlers.set(
            channel,
            (rawHandlers.get(channel) ?? []).filter((registered) => registered !== handler),
          )
        }
      },
    },
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    sendUserMessage: async (content) => {
      messages.push(userMessageText(content))
    },
    sendMessage: (message, options) => {
      const text = typeof message === 'string' ? message : String(message?.content ?? '')
      messages.push(text)
      if (options?.triggerTurn === true && typeof message === 'object' && message !== null && 'display' in message) {
        messages.push(`display:${String(message.display)} triggerTurn:true`)
      }
    },
  })
  const controller = new NativeBatchController()
  // Control-only. No git identity is claimed; the integration probe owns the real observer.
  controller.bindHostGit(() => null)
  installNativeBatchBridge(native, controller)
  function prepareRoot(context: Record<string, unknown>): void {
    const model = { id: 'fixture-model', provider: 'fixture-provider' }
    context.cwd ??= '/fixture-root'
    context.sessionManager ??= { getSessionId: () => 'fixture-root-session' }
    context.models ??= { resolve: () => model, current: () => model }
    context.model ??= model
    provisionUnitSdkRoot(String(context.cwd))
  }
  function startRootIfNeeded(event: string, context: unknown): Promise<unknown> | undefined {
    if (!context || typeof context !== 'object' || !('agent' in context)) return
    const agent = context.agent
    if (!agent || typeof agent !== 'object' || !('kind' in agent) || agent.kind !== 'main') return
    prepareRoot(context as Record<string, unknown>)
    if (event === 'session_start') startedRoots.add(context)
    else if (event === 'tool_call' && !startedRoots.has(context)) {
      startedRoots.add(context)
      return emitBridge('session_start', { type: 'session_start' }, context)
    }
  }
  async function emitBridge(event: string, ...args: unknown[]): Promise<unknown> {
    const start = startRootIfNeeded(event, args[1])
    if (start) await start
    const pending = (handlers.get(event) ?? []).map((handler) => handler(...(args as never[])))
    let result: unknown
    for (const value of await Promise.all(pending)) result = value ?? result
    if (event === 'tool_call') {
      const value = args[0] as { toolName?: string; toolCallId?: string } | undefined
      if (value?.toolName === 'task' && typeof value.toolCallId === 'string' && result === undefined) {
        admittedCall = value.toolCallId
        admittedBatch = controller.active()
      }
    }
    return result
  }
  return {
    controller,
    native,
    messages,
    emitBridge,
    async emitBridgeAndSettle(event, ...args) {
      const result = emitBridge(event, ...args)
      const terminal = event === 'tool_result' ? controller.ownedSettlement() : undefined
      const resolved = await result
      if (terminal !== undefined) await terminal
      return resolved
    },
    emitRaw(value) {
      emitRawChannel('task:subagent:event', value)
    },
    async admitChild(prepared, logicalName, allocatedId = logicalName, options = {}) {
      const task = prepared.tasks.tasks.find((candidate) => candidate.name === logicalName)
      if (!task) throw new Error(`fixture task missing: ${logicalName}`)
      const context = options.root ?? { ...root }
      prepareRoot(context)
      if (admittedBatch !== prepared) admittedCall = null
      if (admittedCall === null && !options.skipRootCall) {
        await emitBridge(
          'tool_call',
          {
            type: 'tool_call',
            toolName: 'task',
            toolCallId: options.toolCallId ?? 'task-call',
            input: controller.wire(prepared),
          },
          context,
        )
      }
      const refusal = await emitBridge(
        'before_subagent_spawn',
        {
          type: 'before_subagent_spawn',
          invocationKind: 'task',
          agent: task.agent,
          patterns: [],
          spawnKey: allocatedId,
        },
        context,
      )
      if (refusal !== undefined) throw new Error(`fixture child spawn refused: ${JSON.stringify(refusal)}`)
      const sessionFile = join(tmpdir(), `fixture-child-${randomUUID()}.jsonl`)
      emitRawChannel('task:subagent:lifecycle', {
        status: 'started',
        id: allocatedId,
        agent: task.agent,
        index: prepared.tasks.tasks.indexOf(task),
        parentToolCallId: admittedCall ?? options.toolCallId ?? 'task-call',
        sessionFile,
        detached: false,
      })
      const child = await nativeReviewChild({ task: { ...task, name: allocatedId }, sessionFile })
      children.set(allocatedId, child)
      return child
    },
    async yieldChild(allocatedId, data, options = {}) {
      const child = children.get(allocatedId)
      if (!child) throw new Error(`fixture child not admitted: ${allocatedId}`)
      const id = options.toolCallId ?? 'yield-call'
      const input = { data }
      await child.call('yield', id, input)
      await child.result('yield', id, input, { content: [], details: {}, isError: false })
    },
  }
}

const fixtureActionDirs = new Set<string>()

export function cleanupFixtureActions(): void {
  for (const directory of fixtureActionDirs) rmSync(directory, { recursive: true, force: true })
  fixtureActionDirs.clear()
}

export function fixtureAction(
  actionId: string,
  agent = 'R-review-adversarial',
  baseInputs = standaloneReviewInputs(),
  register = true,
): PreparedUwAction {
  const directory = join(tmpdir(), `omp-action-${randomUUID()}`)
  fixtureActionDirs.add(directory)
  mkdirSync(join(directory, 'plugin', 'agents'), { recursive: true })
  const bytes = new TextEncoder().encode(`# ${actionId}\n`)
  const profile = readFileSync(new URL(`../agents/${agent}.md`, import.meta.url))
  const plugin = baseInputs.manifest.plugin
  const manifest = {
    ...baseInputs.manifest,
    plugin: {
      ...plugin,
      files: [
        ...plugin.files.filter((file) => file.path !== `${plugin.root}/agents/${agent}.md`),
        {
          source: 'git-file' as const,
          repository: plugin.repository,
          commit: plugin.commit,
          path: `${plugin.root}/agents/${agent}.md`,
          digest: createHash('sha256').update(profile).digest('hex'),
        },
      ],
    },
  }
  const inputs = { ...baseInputs, manifest, fingerprint: actionInputDigest(manifest) }
  writeFileSync(join(directory, 'index.md'), bytes)
  writeFileSync(join(directory, 'plugin', 'agents', `${agent}.md`), profile)
  const sealed = sealActionSnapshot(
    {
      id: `fixture-${actionId}`,
      actionId,
      manifestDigest: inputs.fingerprint,
      indexPath: join(directory, 'index.md'),
      location: 'local',
    },
    [
      { path: 'index.md', bytes },
      { path: `plugin/agents/${agent}.md`, bytes: profile },
    ],
  )
  if (!sealed.ok) throw new Error(sealed.diagnostics.map((item) => item.code).join(','))
  if (register) registerHostActionBinding(sealed.value, inputs)
  return { snapshot: sealed.value, inputs }
}

export function batch(names: readonly string[]): NativeBatch {
  return {
    operationId: 'native-op',
    tasks: {
      context: 'native bridge fixture',
      tasks: names.map((name) => ({
        name,
        agent: 'R-review-adversarial',
        task: name,
        solutionSpace: 'fixed fixture',
        action: fixtureAction(name),
      })),
    },
  }
}
