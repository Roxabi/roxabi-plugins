import { execFileSync } from 'node:child_process'

import { createExtensionApiStub } from '../omp/__tests__/extension-api-stub.ts'
import ompBuildExtension from '../omp/index.ts'
import { ownedFixRunFor, reviewControllerFor } from '../omp/omp-controller.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type { NativeBatchController } from '../omp/review-runtime/controller.ts'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'

type Handler = (...args: unknown[]) => unknown
export type NativeData = { findings: unknown[] } | Record<string, unknown>
type Task = NativeTask
type RootContext = {
  cwd: string
  agent: { kind: 'main'; id: string; name: string; depth: number }
  model: { contextWindow: number }
  isIdle(): boolean
}
export type ActionProof = { command: string; args: string[]; program?: string; prepare?(): void; restore?(): void }
export type ReviewDriver = {
  controller: NativeBatchController
  messages: string[]
  fixRun(): FixRun | undefined
  fixTransition(after: number): Promise<'next-batch' | 'terminal'>
  fixTerminal(): FixRun['terminal']
  pause(): Promise<unknown[]>
  settle(data: (task: Task) => NativeData): Promise<void>
  settleAction(data: (task: Task) => NativeData, proof: ActionProof): Promise<void>
}

function addHandler(events: Map<string, Handler[]>, name: string, handler: Handler): void {
  events.set(name, [...(events.get(name) ?? []), handler])
}

async function emit(events: Map<string, Handler[]>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of events.get(name) ?? []) await handler(...args)
}

function rootContext(cwd: string): RootContext {
  return {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128000 },
    isIdle: () => true,
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
  data: (task: Task) => NativeData
  proof?: ActionProof
}

async function captureProof(input: DriverSettlement, task: Task): Promise<void> {
  if (input.proof === undefined) return
  const toolCallId = `${task.name}-proof`
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: { type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command: input.proof.command } },
  })
  let exitCode = 0
  try {
    execFileSync(input.proof.program ?? 'git', input.proof.args, { cwd: input.context.cwd, stdio: 'ignore' })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number')
      exitCode = error.status
    else throw error
  } finally {
    input.proof.restore?.()
  }
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId,
      isError: exitCode !== 0,
      result: { content: [], details: { exitCode } },
    },
  })
}

async function settleChild(input: DriverSettlement, task: Task): Promise<void> {
  await emit(
    input.events,
    'before_subagent_spawn',
    { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
    input.context,
  )
  input.proof?.prepare?.()
  await captureProof(input, task)
  await emit(input.events, 'task:subagent:event', {
    id: task.name,
    event: {
      type: 'tool_execution_start',
      toolName: 'yield',
      toolCallId: `${task.name}-yield`,
      args: { data: input.data(task) },
    },
  })
}

async function settleDriver(input: DriverSettlement): Promise<void> {
  const batch = input.controller.active()
  if (batch === null) throw new Error('review-batch-missing')
  const wire = input.controller.wire(batch)
  if (wire === null) throw new Error('review-batch-unwired')
  await emit(input.events, 'tool_call', { toolName: 'task', toolCallId: batch.operationId, input: wire }, input.context)
  for (const task of batch.tasks.tasks) await settleChild(input, task)
  await emit(
    input.events,
    'tool_result',
    {
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
          structuredOutput: { status: 'valid', data: input.data(task) },
        })),
      },
    },
    input.context,
  )
}

export async function createReviewDriver(cwd: string): Promise<ReviewDriver> {
  const events = new Map<string, Handler[]>()
  const commands = new Map<string, Handler>()
  const messages: string[] = []
  const batchWaiters: Array<{ after: number; resolve: () => void }> = []
  const recordMessage = (message: unknown): void => {
    const text =
      typeof message === 'string'
        ? message
        : typeof message === 'object' && message !== null && 'content' in message
          ? String(message.content)
          : String(message)
    messages.push(text)
    if (!text.includes('OMP_BUILD_NATIVE_BATCH')) return
    for (const waiter of batchWaiters.splice(0)) if (messages.length > waiter.after) waiter.resolve()
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
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  const controller = reviewControllerFor(api)
  return {
    controller,
    messages,
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
    fixTerminal: () => {
      const run = ownedFixRunFor(api)?.run
      if (run === undefined) throw new Error('fix-run-missing')
      return run.terminal
    },
    pause: () => pause(events, context),
    settle: (data) => settleDriver({ controller, context, events, data }),
    settleAction: (data, proof) => settleDriver({ controller, context, events, data, proof }),
  }
}
