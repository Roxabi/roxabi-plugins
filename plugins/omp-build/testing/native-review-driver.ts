import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import ompBuildExtension from '../omp/index.ts'
import { createOmpFixPort, hasOwnedFixRun, ownedFixRunFor, reviewControllerFor } from '../omp/omp-controller.ts'
import { dispatchDefaultFix } from '../omp/omp-fix-dispatch.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type { NativeBatchController } from '../omp/review-runtime/controller.ts'
import type { NativePort } from '../roxabi/fix-contract.ts'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import { createExtensionApiStub, fixtureEventBus } from './extension-api-stub.ts'
import { nativeReviewChild } from './native-review-child.ts'
import { observeDriverCallbacks } from './native-review-diagnostics.ts'
import { dispatchInitialCommand } from './native-review-dispatch.ts'
import { emit, pause, type RootContext, rootContext } from './native-review-driver-events.ts'
import { type BatchWaiter, type ContinuationWaiter, messageText, notifyWaiters } from './native-review-notifications.ts'
import { captureNativeReviewProof } from './native-review-proof.ts'
import { provisionNativeRoot } from './native-root-fixture.ts'
import { operatorDialogUi } from './operator-dialog-ui.ts'

type Handler = (...args: unknown[]) => unknown
export type NativeData = { findings: unknown[] } | Record<string, unknown>
export type ActionProof = { command: string; args: string[]; program?: string; prepare?(): void; restore?(): void }
export type ReviewDriver = {
  controller: NativeBatchController
  native: NativePort
  messages: string[]
  diagnostics: Record<string, unknown>[]
  fixRun(): FixRun | undefined
  hasFixIngress(): boolean
  beginFeature(): Promise<void>
  fixTransition(after: number): Promise<'next-batch' | 'terminal'>
  nextBatch(after: number): Promise<void>
  fixTerminal(): FixRun['terminal']
  pause(): Promise<unknown[]>
  pauseFeature(): Promise<void>
  continueFeature(): Promise<void>
  settle(data: (task: NativeTask) => NativeData): Promise<void>
  settleAction(data: (task: NativeTask) => NativeData, proof: ActionProof): Promise<void>
}

function addHandler(events: Map<string, Handler[]>, name: string, handler: Handler): void {
  events.set(name, [...(events.get(name) ?? []), handler])
}

type DriverSettlement = {
  controller: NativeBatchController
  context: RootContext
  events: Map<string, Handler[]>
  messages: string[]
  data: (task: NativeTask) => NativeData
  proof?: ActionProof
}

async function settleChild(
  input: DriverSettlement,
  task: NativeTask,
  operationId: string,
  index: number,
): Promise<NativeData> {
  if (!input.controller.bindChild(task.name, index, input.context.models.resolve(task.agent))) {
    throw new Error(`native-fixture-child-binding-refused: ${task.name}`)
  }
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
  await captureNativeReviewProof(input.proof, input.context.cwd, task, child, (event) =>
    emit(input.events, 'task:subagent:event', event),
  )
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
  if (input.controller.wire(batch) === null) throw new Error('review-batch-unwired')
  if (!input.controller.admit(batch, batch.operationId, input.context as never, () => true)) {
    throw new Error('review-batch-admission-refused')
  }
  const results: NativeData[] = []
  for (const [index, task] of batch.tasks.tasks.entries())
    results.push(await settleChild(input, task, batch.operationId, index))
  const observation = {
    toolCallId: batch.operationId,
    errors: [],
    results: batch.tasks.tasks.map((task, index) => ({
      index,
      id: task.name,
      agent: task.agent,
      exitCode: 0,
      structuredOutput: { status: 'valid', data: results[index] },
    })),
  }
  input.controller.prepareOwnedResult(observation, input.context as never)
  input.controller.queueOwnedSettlement(observation)
  const settlement = input.controller.ownedSettlement()
  input.controller.finishExecution(batch)
  const endTurn = emit(input.events, 'agent_end', { willContinue: false }, input.context)
  const outcomes = await Promise.allSettled([endTurn, settlement])
  const failures = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Review driver turn and settlement failed')
}

export async function createReviewDriver(
  cwd: string,
  contextWindow = 128_000,
  mode: 'feature' | 'review-only' | 'fix-pr' | 'fix-issue' = 'feature',
  activatePin = false,
  deferred = false,
): Promise<ReviewDriver> {
  const events = new Map<string, Handler[]>()
  const commands = new Map<string, Handler>()
  const tools = new Map<string, Handler>()
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
    events: fixtureEventBus((name, handler) => {
      addHandler(events, name, handler as Handler)
      return () => undefined
    }),
    registerCommand: (name, command) => commands.set(name, command.handler as Handler),
    registerTool: (tool) => {
      tools.set(tool.name, tool.execute as Handler)
    },
    sendUserMessage: async (message) => {
      recordMessage(message)
    },
    sendMessage: recordMessage,
  })
  const context = rootContext(cwd, contextWindow)
  if (deferred) {
    const getSessionId = context.sessionManager.getSessionId
    let switched = false
    context.sessionManager.getSessionId = () => {
      if (!switched && hasOwnedFixRun(api) && ownedFixRunFor(api) === undefined) {
        switched = true
        process.env.GH_TOKEN = `fixture-ingress-${randomUUID()}`
      }
      return getSessionId()
    }
  }
  if (activatePin) {
    Object.assign(context, {
      hasUI: true,
      mode: 'tui',
      ui: {
        ...operatorDialogUi(async () => 'confirm'),
        notify: recordMessage,
        setStatus: (key: string, text?: string) => recordMessage(`status ${key}: ${text ?? ''}`),
      },
    })
    Object.assign(context.sessionManager, { getCwd: () => cwd })
  }
  provisionNativeRoot(context)
  ompBuildExtension(api)
  const controller = reviewControllerFor(api)
  const diagnostics = observeDriverCallbacks(controller)
  await emit(events, 'session_start', { type: 'session_start' }, context)
  if (activatePin) {
    const pinCommand = commands.get('tooling-pin')
    if (pinCommand === undefined) throw new Error('tooling-pin-command-unregistered')
    await pinCommand('activate', context)
    if (!messages.some((message) => message.includes('tooling-pin: activated for this session')))
      throw new Error(`tooling-pin-activation-failed: ${JSON.stringify(messages)}`)
  }
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  const fix = (args: unknown, ctx: unknown) => dispatchDefaultFix(api, ctx as never, String(args))
  if (!deferred) await dispatchInitialCommand(fix, tools, mode, context, feature)
  return {
    controller,
    native: createOmpFixPort(api),
    messages,
    diagnostics,
    fixRun: () => ownedFixRunFor(api)?.run,
    hasFixIngress: () => hasOwnedFixRun(api),
    beginFeature: async () => {
      await feature('#42', context)
    },
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
    continueFeature: async () => {
      await feature('#42', context)
    },
    pause: () => pause(events, context),
    pauseFeature: async () => {
      await feature('pause #42', context)
    },
    settle: (data) => settleDriver({ controller, context, events, messages, data }),
    settleAction: (data, proof) => settleDriver({ controller, context, events, messages, data, proof }),
  }
}
