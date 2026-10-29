import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import * as hostSdk from '@oh-my-pi/pi-coding-agent'
import { cfgTaskAgentModelOverrides } from '@oh-my-pi/pi-coding-agent/task/settings'
import ompBuildExtension from '../omp/index.ts'
import { ownedFixRunFor, reviewControllerFor } from '../omp/omp-controller.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type { NativeBatchController } from '../omp/review-runtime/controller.ts'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { type NativeReviewChild, nativeReviewChild } from './native-review-child.ts'
import { observeDriverCallbacks } from './native-review-diagnostics.ts'

type Handler = (...args: unknown[]) => unknown
export type NativeData = { findings: unknown[] } | Record<string, unknown>
type RootContext = {
  cwd: string
  agent: { kind: 'main'; id: string; name: string; depth: number }
  model: { contextWindow: number }
  models: { resolve(role: string): { id: string; provider: string } }
  isIdle(): boolean
  localProtocolOptions: { getArtifactsDir(): string }
  sessionManager: { getSessionId(): string }
}
export type ActionProof = { command: string; args: string[]; program?: string; prepare?(): void; restore?(): void }
export type ReviewDriver = {
  controller: NativeBatchController
  messages: string[]
  diagnostics: Record<string, unknown>[]
  fixRun(): FixRun | undefined
  fixTransition(after: number): Promise<'next-batch' | 'terminal'>
  nextBatch(after: number): Promise<void>
  fixTerminal(): FixRun['terminal']
  pause(): Promise<unknown[]>
  settle(data: (task: NativeTask) => NativeData): Promise<void>
  settleAction(data: (task: NativeTask) => NativeData, proof: ActionProof): Promise<void>
}

function addHandler(events: Map<string, Handler[]>, name: string, handler: Handler): void {
  events.set(name, [...(events.get(name) ?? []), handler])
}

function modelRouteDiagnostic(context: unknown): string {
  try {
    const manager = Reflect.get(hostSdk, 'SettingsManager')
    if (!manager || typeof manager.create !== 'function') return 'SDK root SettingsManager unavailable'
    if (typeof context !== 'object' || context === null || !('cwd' in context)) return 'root cwd unavailable'
    const settings = manager.create(context.cwd)
    const overrides = cfgTaskAgentModelOverrides.get(settings)
    return `SDK Settings=${settings.constructor?.name ?? 'unknown'}; rawValue=${typeof settings.rawValue}; overrides=${typeof overrides}; cwd matches fixture=${context.cwd === process.argv[3]}`
  } catch (error) {
    return `SDK settings failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function emit(events: Map<string, Handler[]>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of events.get(name) ?? []) {
    const result = await handler(...args)
    if (typeof result === 'object' && result !== null && 'block' in result && result.block === true) {
      const reason = 'reason' in result ? String(result.reason) : 'no reason provided'
      const detail = name === 'before_subagent_spawn' ? `; ${modelRouteDiagnostic(args[1])}` : ''
      throw new Error(`native-fixture-${name}-refused: ${reason}${detail}`)
    }
  }
}

function rootContext(cwd: string): RootContext {
  return {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128000 },
    models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
    isIdle: () => true,
    localProtocolOptions: { getArtifactsDir: () => join(dirname(cwd), 'native-review-artifacts') },
    sessionManager: { getSessionId: () => 'native-review-fixture-root' },
  }
}

function pause(events: Map<string, Handler[]>, context: RootContext): Promise<unknown[]> {
  return Promise.all(
    (events.get('message_end') ?? []).map((handler) =>
      handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67108864 } }, context),
    ),
  )
}

type DriverSettlement = {
  controller: NativeBatchController
  context: RootContext
  events: Map<string, Handler[]>
  messages: string[]
  data: (task: NativeTask) => NativeData
  proof?: ActionProof
}

async function captureProof(input: DriverSettlement, task: NativeTask, child: NativeReviewChild): Promise<void> {
  if (input.proof === undefined) return
  const toolCallId = `${task.name}-proof`
  await child.call('bash', toolCallId, { command: input.proof.command })
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: { type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command: input.proof.command } },
  })
  const execution = spawnSync(input.proof.program ?? 'git', input.proof.args, {
    cwd: input.context.cwd,
    encoding: 'utf8',
  })
  input.proof.restore?.()
  if (execution.error) throw execution.error
  if (execution.status === null) throw new Error(`proof terminated by signal: ${execution.signal}`)
  const exitCode = execution.status
  const content = [{ type: 'text', text: `${execution.stdout}${execution.stderr}` }]
  await child.result(
    'bash',
    toolCallId,
    { command: input.proof.command },
    {
      content,
      details: { exitCode },
      isError: exitCode !== 0,
    },
  )
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId,
      isError: exitCode !== 0,
      result: { content, details: { exitCode } },
    },
  })
}

async function settleChild(
  input: DriverSettlement,
  task: NativeTask,
  operationId: string,
  index: number,
): Promise<NativeData> {
  await emit(
    input.events,
    'before_subagent_spawn',
    { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
    input.context,
  )
  input.proof?.prepare?.()
  const sessionFile = join(input.context.cwd, `.fixture-child-${randomUUID()}.jsonl`)
  await emit(input.events, 'task:subagent:lifecycle', {
    status: 'started',
    id: task.name,
    agent: task.agent,
    index,
    parentToolCallId: operationId,
    sessionFile,
    detached: false,
  })
  const child = await nativeReviewChild({ task, sessionFile })
  await captureProof(input, task, child)
  const data = input.data(task)
  await child.call('yield', `${task.name}-yield`, { data })
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: {
      type: 'tool_execution_start',
      toolName: 'yield',
      toolCallId: `${task.name}-yield`,
      args: { data },
    },
  })
  await child.result('yield', `${task.name}-yield`, { data }, { content: [], details: {}, isError: false })
  return data
}

async function settleDriver(input: DriverSettlement): Promise<void> {
  const batch = input.controller.active()
  if (batch === null) throw new Error(`review-batch-missing: ${JSON.stringify(input.messages)}`)
  const wire = input.controller.wire(batch)
  if (wire === null) throw new Error('review-batch-unwired')
  await emit(input.events, 'tool_call', { toolName: 'task', toolCallId: batch.operationId, input: wire }, input.context)
  const results: NativeData[] = []
  for (const [index, task] of batch.tasks.tasks.entries())
    results.push(await settleChild(input, task, batch.operationId, index))
  const handlers = input.events.get('tool_result') ?? []
  const event = {
    toolName: 'task',
    toolCallId: batch.operationId,
    isError: false,
    content: [],
    details: {
      results: batch.tasks.tasks.map((task, index) => ({
        index,
        id: task.name,
        agent: task.agent,
        exitCode: 0,
        structuredOutput: { status: 'valid', data: results[index] },
      })),
    },
  }
  for (const handler of handlers) {
    const result = handler(event, input.context)
    const terminal = input.controller.ownedSettlement()
    await result
    await terminal
    await input.controller.ownedSettlement()
  }
}

type BatchWaiter = { after: number; resolve: () => void }
type ContinuationWaiter = { resolve: () => void; reject: (error: Error) => void }

function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (typeof message === 'object' && message !== null && 'content' in message) return String(message.content)
  return String(message)
}

function notifyWaiters(text: string, count: number, batches: BatchWaiter[], continuations: ContinuationWaiter[]): void {
  if (text.includes('OMP_BUILD_NATIVE_BATCH')) {
    for (const waiter of continuations.splice(0)) waiter.resolve()
    for (const waiter of batches.splice(0)) if (count > waiter.after) waiter.resolve()
  } else if (text.startsWith('feature-stopped:')) {
    for (const waiter of continuations.splice(0)) waiter.reject(new Error(text))
  }
}

export async function createReviewDriver(cwd: string): Promise<ReviewDriver> {
  const events = new Map<string, Handler[]>()
  const commands = new Map<string, Handler>()
  const messages: string[] = []
  const batchWaiters: BatchWaiter[] = []
  const continuationWaiters: ContinuationWaiter[] = []
  const recordMessage = (message: unknown): void => {
    const text = messageText(message)
    messages.push(text)
    notifyWaiters(text, messages.length, batchWaiters, continuationWaiters)
  }
  const api = createExtensionApiStub({
    on: (name, handler) => addHandler(events, name, handler as Handler),
    events: {
      on: (name, handler) => {
        addHandler(events, name, handler as Handler)
        return () => undefined
      },
    },
    registerCommand: (name, command) => commands.set(name, command.handler as Handler),
    sendUserMessage: recordMessage,
    sendMessage: recordMessage,
  })
  const context = rootContext(cwd)
  ompBuildExtension(api)
  const controller = reviewControllerFor(api)
  const diagnostics = observeDriverCallbacks(controller)
  await emit(events, 'session_start', { type: 'session_start' }, context)
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  return {
    controller,
    messages,
    diagnostics,
    fixRun: () => ownedFixRunFor(api)?.run,
    fixTransition: (after) => {
      const run = ownedFixRunFor(api)?.run
      if (run === undefined) throw new Error('fix-run-missing')
      const { promise, resolve } = Promise.withResolvers<void>()
      const waiter = { after, resolve }
      batchWaiters.push(waiter)
      return Promise.race([
        promise.then((): 'next-batch' => 'next-batch'),
        run.completion.then(
          (): 'terminal' => 'terminal',
          (): 'terminal' => 'terminal',
        ),
      ]).finally(() => {
        const index = batchWaiters.indexOf(waiter)
        if (index !== -1) batchWaiters.splice(index, 1)
      })
    },
    nextBatch: (after) => {
      const relevant = messages
        .slice(after)
        .find((message) => message.includes('OMP_BUILD_NATIVE_BATCH') || message.startsWith('feature-stopped:'))
      if (relevant?.startsWith('feature-stopped:')) return Promise.reject(new Error(relevant))
      if (relevant !== undefined) return Promise.resolve()
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      continuationWaiters.push({ resolve, reject })
      return promise
    },
    fixTerminal: () => {
      const run = ownedFixRunFor(api)?.run
      if (run === undefined) throw new Error('fix-run-missing')
      return run.terminal
    },
    pause: () => pause(events, context),
    settle: (data) => settleDriver({ controller, context, events, messages, data }),
    settleAction: (data, proof) => settleDriver({ controller, context, events, messages, data, proof }),
  }
}
