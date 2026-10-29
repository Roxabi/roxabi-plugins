import { randomUUID } from 'node:crypto'
import type { NativeExtension, NativeTask } from '../omp/review-runtime/contracts.ts'
import { NativeBatchController } from '../omp/review-runtime/controller.ts'
import { installExecutedChildGuard } from '../omp/review-runtime/executed-child-guard.ts'
import { loadPinnedProfile } from '../omp/review-runtime/executed-child-profile.ts'

type Handler = (...args: unknown[]) => unknown
export type NativeReviewChild = {
  hook(name: string, event: unknown): Promise<unknown>
  message(event: { type: string; [key: string]: unknown }): Promise<unknown>
  call(toolName: string, toolCallId: string, toolInput: unknown): Promise<void>
  result(
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    result: { content: unknown[]; details: unknown; isError: boolean },
  ): Promise<void>
}

/** Simulate the SDK's child extension hooks from the actual sealed profile and task. */
export async function nativeReviewChild(input: { task: NativeTask; sessionFile: string }): Promise<NativeReviewChild> {
  const profile = await loadPinnedProfile(input.task)
  if (profile === null) throw new Error(`native-fixture-pinned-profile-missing: ${input.task.agent}`)
  const handlers = new Map<string, Handler>()
  // The SDK's registry is independent of its enabled tools. This fixture models
  // a host without lsp and with ambient extension/MCP tools already enabled.
  const builtins = [
    'read',
    'grep',
    'glob',
    'bash',
    'ast_grep',
    'web_search',
    'write',
    'edit',
    'yield',
    'wait',
    'find',
    'ask',
    'todo',
    'recall',
    'reflect',
    'retain',
    'memory_edit',
    'checkpoint',
    'rewind',
  ]
  const allTools = [
    ...builtins.map((name) => ({
      name,
      sourceInfo: { source: 'builtin', path: `<builtin:${name}>`, scope: 'temporary', origin: 'top-level' },
    })),
    {
      name: 'fixture_custom',
      sourceInfo: { source: 'extension', path: '<fixture>', scope: 'temporary', origin: 'top-level' },
    },
    {
      name: 'fixture_mcp',
      sourceInfo: { source: 'mcp', path: '<fixture-mcp>', scope: 'temporary', origin: 'top-level' },
    },
  ]
  const available = new Set(allTools.map((tool) => tool.name))
  const initialTools = [
    ...new Set([...profile.tools.filter((name) => available.has(name)), 'yield', 'fixture_custom', 'fixture_mcp']),
  ]
  let active = [...initialTools]
  const pi = {
    events: { on: () => () => undefined },
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler)
    },
    getActiveTools: () => [...active],
    getAllTools: () => allTools.map((tool) => ({ ...tool, sourceInfo: { ...tool.sourceInfo } })),
    setActiveTools: async (names: string[]) => {
      active = [...new Set(names.filter((name) => available.has(name)))]
    },
  } as unknown as NativeExtension
  installExecutedChildGuard(pi, new NativeBatchController())
  const taskText = `Complete assignment thoroughly:\n\n${input.task.task.trim()}`
  const readOnlyTools = [
    'read',
    'wait',
    'grep',
    'glob',
    'find',
    'web_search',
    'ast_grep',
    'yield',
    'ask',
    'todo',
    'recall',
    'reflect',
    'retain',
    'memory_edit',
    'checkpoint',
    'rewind',
  ]
  const model = { id: 'fixture-model', provider: 'fixture-provider' }
  let systemPrompt: string[] = []
  let aborted = false
  const ctx = {
    agent: { kind: 'sub', id: input.task.name, name: input.task.agent, depth: 1, parentId: 'Main' },
    sessionManager: {
      getSessionFile: () => input.sessionFile,
      getSessionId: () => `fixture-child-${randomUUIDValue}`,
      getEntries: () => [
        {
          type: 'session_init',
          agent: input.task.agent,
          task: taskText,
          systemPrompt: [],
          tools: [...initialTools],
          spawns: '',
          modelRole: profile.model,
          resolvedModel: 'fixture-provider/fixture-model',
          readOnly: profile.tools.length > 0 && profile.tools.every((tool) => readOnlyTools.includes(tool)),
          outputSchema: profile.outputSchema,
          outputSchemaMode: 'permissive',
        },
      ],
    },
    model,
    models: { resolve: () => model, current: () => model },
    getSystemPrompt: () => systemPrompt,
    abort: () => {
      aborted = true
    },
  }
  const randomUUIDValue = randomUUID()
  async function hook(name: string, event: unknown): Promise<unknown> {
    return await handlers.get(name)?.(event, ctx)
  }
  await hook('session_start', { type: 'session_start' })
  const start = (await hook('before_agent_start', { type: 'before_agent_start', prompt: taskText })) as
    | { systemPrompt?: string[] }
    | undefined
  if (aborted || start?.systemPrompt === undefined)
    throw new Error(`native-fixture-child-start-refused: agent=${input.task.agent}, child=${input.task.name}`)
  systemPrompt = start.systemPrompt
  const messages: Array<{ role: string; content: unknown; attribution?: string }> = [
    { role: 'user', content: taskText, attribution: 'agent' },
  ]
  return {
    hook,
    message: (event) => hook(event.type, event),
    async call(toolName: string, toolCallId: string, toolInput: unknown) {
      await hook('context', { type: 'context', messages })
      await hook('before_provider_request', { type: 'before_provider_request', payload: {} })
      const result = (await hook('tool_call', { type: 'tool_call', toolName, toolCallId, input: toolInput })) as
        | { block?: boolean; reason?: string }
        | undefined
      if (result?.block)
        throw new Error(`native-fixture-child-call-refused: ${toolName}: ${result.reason ?? 'unknown'}`)
    },
    async result(
      toolName: string,
      toolCallId: string,
      toolInput: unknown,
      result: { content: unknown[]; details: unknown; isError: boolean },
    ) {
      await hook('tool_result', { type: 'tool_result', toolName, toolCallId, input: toolInput, ...result })
      messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: toolInput }],
      })
      messages.push({ role: 'toolResult', content: result.content })
    },
  }
}
