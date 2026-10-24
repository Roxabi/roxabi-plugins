import { createExtensionApiStub } from '../omp/__tests__/extension-api-stub.ts'
import ompBuildExtension from '../omp/index.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'

type Handler = (...args: unknown[]) => unknown

export async function invokeOmpIncompleteNative(cwd: string): Promise<{
  operationId: string
  activeAfterSettlement: boolean
  messages: string[]
  completionError: string | null
}> {
  const commands = new Map<string, Handler>()
  const events = new Map<string, Handler[]>()
  const messages: string[] = []
  const api = createExtensionApiStub({
    events: {
      on(name, handler) {
        events.set(name, [...(events.get(name) ?? []), handler as Handler])
        return () => undefined
      },
    },
    on(name, handler) {
      events.set(name, [...(events.get(name) ?? []), handler as Handler])
    },
    registerCommand(name, command) {
      commands.set(name, command.handler as Handler)
    },
    sendUserMessage: (message) => {
      if (typeof message !== 'string') throw new Error('native-announcement-not-text')
      messages.push(message)
    },
    sendMessage: (message) =>
      messages.push(typeof message === 'string' ? message : String(message?.content ?? message)),
    async exec(): Promise<never> {
      throw new Error('unexpected-omp-exec')
    },
  })
  const context = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    isIdle: () => true,
  }
  const emit = async (event: string, ...args: unknown[]) => {
    for (const handler of events.get(event) ?? []) await handler(...args)
  }
  ompBuildExtension(api, { principalCwd: () => false })
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  const controller = reviewControllerFor(api)
  const active = controller.active()
  if (active === null) throw new Error('feature-batch-not-active')
  const task = active.tasks.tasks[0]
  const wire = controller.wire(active)
  if (task === undefined || wire === null) throw new Error('feature-batch-unwired')
  await emit('tool_call', { toolName: 'task', toolCallId: active.operationId, input: wire }, context)
  await emit(
    'before_subagent_spawn',
    { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
    context,
  )
  await emit('task:subagent:event', {
    id: task.name,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'incomplete native child output' },
    },
  })
  await emit('task:subagent:event', {
    id: task.name,
    event: {
      type: 'tool_execution_start',
      toolName: 'yield',
      toolCallId: 'incomplete-yield',
      args: { data: { outcome: 'incomplete', provenance: 'native' } },
    },
  })
  let completionError: string | null = null
  try {
    await emit(
      'tool_result',
      {
        toolName: 'task',
        toolCallId: active.operationId,
        isError: true,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: task.name,
              agent: task.agent,
              exitCode: 1,
              structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
            },
          ],
        },
      },
      context,
    )
  } catch (error) {
    completionError = error instanceof Error ? error.message : String(error)
  }
  return {
    operationId: active.operationId,
    activeAfterSettlement: controller.active() !== null,
    messages,
    completionError,
  }
}
