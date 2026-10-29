import { join } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import {
  agent,
  assignment,
  childId,
  cleanupDirectories,
  preparedBatch,
} from './review-runtime-executed-child-snapshot.fixture.ts'
import { endpoint, eventBus, type ToolEntry, tools } from './review-runtime-sdk-events.fixture.ts'

type Model = { provider: string; id: string }

const taskText = `Complete assignment thoroughly:\n\n${assignment}`
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

async function setup(
  options: {
    profile?: string
    init?: Record<string, unknown> | null
    id?: string
    parentId?: string
    lifecycle?: Record<string, unknown> | null
    omitDetached?: boolean
    beforeSetTools?: () => Promise<void>
    registry?: ToolEntry[]
    initialTools?: string[]
    spawn?: boolean
    cwd?: string
    settings?: unknown
    resolve?: (selector: string) => Model | undefined
    childModel?: Model
    authorizedModel?: Model
  } = {},
) {
  const agent = options.profile ?? 'R-workflow-plan'
  const { prepared, outputSchema, directory } = preparedBatch(agent)
  const bus = eventBus()
  const rootEndpoint = endpoint(bus)
  const childEndpoint = endpoint(eventBus(), options.beforeSetTools, options.registry, options.initialTools)
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
  provisionNativeRoot(root)
  await rootEndpoint.emit('session_start', { type: 'session_start' }, root)
  rootEndpoint.controller.activate(prepared, { onComplete, onStop })
  rootEndpoint.controller.announce(prepared)
  rootEndpoint.controller.consumeFollowUp()
  expect(rootEndpoint.controller.admit(prepared, 'root-call', root as never, () => true)).toBe(true)
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
    const selected = options.authorizedModel ?? model
    const authorized = { provider: selected.provider, id: selected.id }
    if (!rootEndpoint.controller.bindChild(childId, 0, authorized)) {
      return { block: true, reason: 'native child model route unavailable' }
    }
    const result = await rootEndpoint.emit(
      'before_subagent_spawn',
      { type: 'before_subagent_spawn', invocationKind: 'task', agent, patterns: [], spawnKey: childId },
      root,
    )
    if (result === undefined) lifecycle()
    return result
  }
  if (options.spawn !== false) expect(await spawn()).toBeUndefined()
  const initialMessage = {
    role: 'user',
    content: [{ type: 'text', text: taskText }],
    attribution: 'agent',
    timestamp: 1,
  }
  async function preflight(text: string) {
    const result = (await childEndpoint.emit(
      'before_agent_start',
      { type: 'before_agent_start', prompt: text, systemPrompt: prompt },
      child,
    )) as { systemPrompt?: string[] } | undefined
    if (!aborted && result?.systemPrompt) prompt = result.systemPrompt
  }
  async function context(messages: unknown[]) {
    if (!aborted) await childEndpoint.emit('context', { type: 'context', messages }, child)
  }
  async function provider() {
    if (aborted) return
    await childEndpoint.emit('before_provider_request', { type: 'before_provider_request', payload: {} }, child)
    if (!aborted) runtime.provider()
  }
  async function start(options: { retries?: number; messages?: unknown[]; prompt?: string } = {}) {
    await childEndpoint.emit('session_start', { type: 'session_start' }, child)
    expect(abort).not.toHaveBeenCalled()
    for (let attempt = 0; attempt <= (options.retries ?? 0) && !aborted; attempt++)
      await preflight(options.prompt ?? taskText)
    await context(options.messages ?? [initialMessage])
    await provider()
  }
  async function continueTurn(text: string, messages: unknown[]) {
    if (aborted) return
    await preflight(text)
    await context(messages)
    await provider()
  }
  async function yieldValue(value: unknown = data) {
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
    rootEndpoint.controller.queueOwnedSettlement({
      toolCallId: 'root-call',
      errors: [],
      results: [{ index: 0, id, agent, exitCode: 0, structuredOutput: { status: 'valid', data: value } }],
    })
    rootEndpoint.controller.finishExecution(prepared)
    await rootEndpoint.controller.ownedSettlement()
  }
  async function switchRoot() {
    rootEndpoint.controller.finishExecution(prepared)
    await rootEndpoint.emit('session_switch', { type: 'session_switch' }, root)
  }
  return {
    root,
    child,
    childEndpoint,
    rootEndpoint,
    switchRoot,
    spawn,
    lifecycle,
    abort,
    runtime,
    bus,
    start,
    initialMessage,
    preflight,
    context,
    provider,
    continueTurn,
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
