import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ompBuildExtension from '../omp/index.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { nativeReviewChild } from './native-review-child.ts'

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
  const artifacts = mkdtempSync(join(tmpdir(), 'recovery-incomplete-'))
  const context = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
    sessionManager: { getSessionId: () => 'recovery-incomplete-root' },
    isIdle: () => true,
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  }
  try {
    const emit = async (event: string, ...args: unknown[]) => {
      for (const handler of events.get(event) ?? []) {
        const result = await handler(...args)
        if (typeof result === 'object' && result !== null && 'block' in result && result.block === true)
          throw new Error(`${event} refused: ${'reason' in result ? String(result.reason) : 'unknown'}`)
      }
    }
    ompBuildExtension(api, { principalCwd: () => false })
    await emit('session_start', { type: 'session_start' }, context)
    const feature = commands.get('feature')
    if (feature === undefined) throw new Error('feature-command-unregistered')
    await feature('#42', context)
    const controller = reviewControllerFor(api)
    const active = controller.active()
    if (active === null) throw new Error(`feature-batch-not-active: ${JSON.stringify(messages)}`)
    const task = active.tasks.tasks[0]
    const wire = controller.wire(active)
    if (task === undefined || wire === null) throw new Error('feature-batch-unwired')
    await emit('tool_call', { toolName: 'task', toolCallId: active.operationId, input: wire }, context)
    await emit(
      'before_subagent_spawn',
      { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
      context,
    )
    const sessionFile = join(artifacts, 'child-0.jsonl')
    await emit('task:subagent:lifecycle', {
      status: 'started',
      id: task.name,
      agent: task.agent,
      index: 0,
      parentToolCallId: active.operationId,
      sessionFile,
      detached: false,
    })
    const child = await nativeReviewChild({ task, sessionFile })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'incomplete native child output' },
    })
    await child.call('yield', 'incomplete-yield', { data: { outcome: 'incomplete', provenance: 'native' } })
    let completionError: string | null = null
    try {
      const resultEvent = emit(
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
      await resultEvent
      await controller.ownedSettlement()
    } catch (error) {
      completionError = error instanceof Error ? error.message : String(error)
    }
    return {
      operationId: active.operationId,
      activeAfterSettlement: controller.active() !== null,
      messages,
      completionError,
    }
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
}
