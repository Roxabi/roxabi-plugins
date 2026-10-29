import { join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'
import {
  agent,
  assignment,
  childId,
  cleanupDirectories,
  preparedBatch,
} from './review-runtime-executed-child-snapshot.fixture.ts'

type Model = { provider: string; id: string }

const taskText = `Complete assignment thoroughly:\n\n${assignment}`
const tools = ['read', 'grep', 'glob', 'lsp', 'ast_grep']
const data = {
  steps: [
    {
      id: 'step-1',
      change: 'Implement criterion',
      doneWhen: 'Criterion satisfied',
      criterionIds: ['C1'],
      evidence: 'Test result',
      paths: ['src/example.ts'],
    },
  ],
  resolutions: [],
}

afterEach(() => {
  cleanupFixtureActions()
  cleanupDirectories()
})

type Handler = (...args: never[]) => unknown
type Bus = {
  api: { on(name: string, handler: (value: unknown) => void): () => void }
  emit(name: string, value: unknown): void
}
function endpoint(bus: Bus, beforeSetTools?: () => Promise<void>) {
  const handlers = new Map<string, Handler[]>()
  let activeTools = [...tools, 'yield']
  const sources = new Map(activeTools.map((name) => [name, 'builtin']))
  const native = createExtensionApiStub({
    events: bus.api,
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]),
    getActiveTools: () => activeTools,
    getAllTools: () => activeTools.map((name) => ({ name, sourceInfo: { source: sources.get(name) } })) as never,
    setActiveTools: async (names) => {
      await beforeSetTools?.()
      activeTools = [...names]
    },
  })
  const controller = new NativeBatchController()
  controller.bindHostGit(() => null)
  installNativeBatchBridge(native, controller)
  return {
    controller,
    async emit(name: string, event: unknown, ctx: unknown) {
      let response: unknown
      for (const handler of handlers.get(name) ?? [])
        response = (await handler(event as never, ctx as never)) ?? response
      return response
    },
    setSource(name: string, source: string) {
      sources.set(name, source)
    },
    addTool(name: string) {
      activeTools.push(name)
      sources.set(name, 'builtin')
    },
  }
}

function eventBus(): Bus {
  const listeners = new Map<string, ((value: unknown) => void)[]>()
  return {
    api: {
      on: (name: string, handler: (value: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler])
        return () => undefined
      },
    },
    emit(name: string, value: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(value)
    },
  }
}

async function setup(
  options: {
    init?: Record<string, unknown> | null
    id?: string
    parentId?: string
    lifecycle?: Record<string, unknown> | null
    omitDetached?: boolean
    beforeSetTools?: () => Promise<void>
    spawn?: boolean
    cwd?: string
    settings?: unknown
    resolve?: (selector: string) => Model | undefined
    childModel?: Model
  } = {},
) {
  const { prepared, outputSchema, directory } = preparedBatch()
  const bus = eventBus()
  const rootEndpoint = endpoint(bus)
  const childEndpoint = endpoint(eventBus(), options.beforeSetTools)
  const sessionFile = join(directory, 'child.jsonl')
  const model = options.childModel ?? { provider: 'fixture', id: 'fixture-model' }
  const cwd = options.cwd ?? '/fixture-root'
  unitSdkRoots.set(cwd, 'settings' in options ? options.settings : {})
  const resolve = vi.fn(options.resolve ?? (() => model))
  const root = {
    ...consultableAgentRoot(),
    cwd,
    sessionManager: { getSessionId: () => 'root-session' },
    models: { resolve },
  }
  const init = {
    type: 'session_init',
    id: 'init',
    timestamp: '2026-01-01T00:00:00.000Z',
    systemPrompt: ['original SDK prompt'],
    task: taskText,
    tools,
    agent,
    modelRole: 'advisor',
    outputSchema,
    spawns: '',
    ...options.init,
  }
  let prompt = ['original SDK prompt']
  let session = 'child-session'
  let aborted = false
  const abort = vi.fn(() => {
    aborted = true
  })
  const runtime = { provider: vi.fn(), tool: vi.fn(), yield: vi.fn() }
  const child = {
    agent: {
      kind: 'sub',
      id: options.id ?? childId,
      name: agent.toLowerCase(),
      depth: 1,
      parentId: options.parentId ?? 'Main',
    },
    sessionManager: {
      getSessionId: () => session,
      getSessionFile: () => sessionFile,
      getEntries: () => (options.init === null ? [] : [init]),
    },
    abort,
    getSystemPrompt: () => prompt,
    model,
    models: { resolve: () => model, current: () => model },
  }
  const onComplete = vi.fn()
  const onStop = vi.fn()
  await rootEndpoint.emit('session_start', { type: 'session_start' }, root)
  rootEndpoint.controller.activate(prepared, { onComplete, onStop })
  await rootEndpoint.emit(
    'tool_call',
    { type: 'tool_call', toolName: 'task', toolCallId: 'root-call', input: rootEndpoint.controller.wire(prepared) },
    root,
  )
  function lifecycle(overrides: Record<string, unknown> = {}) {
    if (options.lifecycle === null) return
    const announcement: Record<string, unknown> = {
      status: 'started',
      id: childId,
      agent,
      index: 0,
      parentToolCallId: 'root-call',
      sessionFile,
      detached: false,
      ...options.lifecycle,
      ...overrides,
    }
    if (options.omitDetached) delete announcement.detached
    bus.emit('task:subagent:lifecycle', announcement)
  }
  async function spawn() {
    const result = await rootEndpoint.emit(
      'before_subagent_spawn',
      { type: 'before_subagent_spawn', invocationKind: 'task', agent, patterns: [], spawnKey: childId },
      root,
    )
    if (result === undefined) lifecycle()
    return result
  }
  if (options.spawn !== false) expect(await spawn()).toBeUndefined()
  async function start() {
    await childEndpoint.emit('session_start', { type: 'session_start' }, child)
    expect(abort).not.toHaveBeenCalled()
    const result = (await childEndpoint.emit(
      'before_agent_start',
      { type: 'before_agent_start', prompt: taskText, systemPrompt: prompt },
      child,
    )) as { systemPrompt?: string[] } | undefined
    if (aborted) return
    if (result?.systemPrompt) prompt = result.systemPrompt
    await childEndpoint.emit('context', { type: 'context', messages: [{ role: 'user', content: taskText }] }, child)
    if (aborted) return
    runtime.provider()
    await childEndpoint.emit('before_provider_request', { type: 'before_provider_request', payload: {} }, child)
  }
  async function yieldValue(value = data) {
    if (aborted) return undefined
    runtime.tool()
    runtime.yield()
    const input = { data: value }
    const call = await childEndpoint.emit(
      'tool_call',
      { type: 'tool_call', toolName: 'yield', toolCallId: 'yield-call', input },
      child,
    )
    await childEndpoint.emit(
      'tool_result',
      {
        type: 'tool_result',
        toolName: 'yield',
        toolCallId: 'yield-call',
        input,
        isError: false,
        content: [],
        details: {},
      },
      child,
    )
    return call
  }
  async function terminal(value: unknown = data, id = childId) {
    await rootEndpoint.emit(
      'tool_result',
      {
        type: 'tool_result',
        toolName: 'task',
        toolCallId: 'root-call',
        isError: false,
        content: [],
        details: {
          results: [{ index: 0, id, agent, exitCode: 0, structuredOutput: { status: 'valid', data: value } }],
        },
      },
      root,
    )
    await rootEndpoint.controller.ownedSettlement()
  }
  return {
    root,
    child,
    childEndpoint,
    rootEndpoint,
    spawn,
    lifecycle,
    abort,
    runtime,
    bus,
    start,
    yieldValue,
    terminal,
    onComplete,
    onStop,
    setPrompt: (value: string[]) => {
      prompt = value
    },
    setSession: (value: string) => {
      session = value
    },
  }
}

export { agent, childId, data, endpoint, eventBus, preparedBatch, setup, taskText, tools }
