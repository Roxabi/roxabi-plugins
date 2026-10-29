import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import {
  agent,
  childId,
  data,
  endpoint,
  eventBus,
  preparedBatch,
  setup,
  taskText,
  tools,
} from './review-runtime-executed-child.fixture.ts'

vi.mock('@oh-my-pi/pi-coding-agent', () => {
  return {
    SettingsManager: {
      create: (cwd: string) => {
        const value = unitSdkRoots.get(cwd)
        if (value instanceof Error) throw value
        if (value === undefined) throw new Error('settings unavailable')
        return { cwd }
      },
    },
  }
})

describe('native executed-child contract', () => {
  const sdkTools = [
    'read',
    'grep',
    'glob',
    'ast_grep',
    'bash',
    'write',
    'task',
    'edit',
    'web_search',
    'browser',
    'memory',
    'mcp_search',
    'mcp_read',
    'slack',
    'calendar',
  ]
  const sdkRegistry = [
    ...['read', 'grep', 'glob', 'ast_grep', 'bash', 'write', 'yield'].map((name) => ({
      name,
      source: 'builtin',
    })),
    ...sdkTools.slice(6).map((name) => ({ name, source: 'extension' })),
  ]

  it('projects the captured review-spec SDK tool inventory to six pinned builtins and yield', async () => {
    const capturedTools = [
      'read',
      'grep',
      'glob',
      'bash',
      'ast_grep',
      'web_search',
      'wait',
      'yield',
      'mcp__codegraph_codegraph_codegraph_explore',
      'mcp__context7_query_docs',
      'mcp__context7_resolve_library_id',
      'omp_build_start_review',
      'omp_build_terminalize_interrupted_review',
      'omp_build_grant_review_replacement',
      'omp_build_replace_interrupted_review',
    ]
    const registry = capturedTools.map((name, index) => ({
      name,
      source: index < 8 ? 'builtin' : 'extension',
    }))
    const fixture = await setup({
      profile: 'R-review-spec',
      init: { tools: capturedTools },
      registry,
      initialTools: capturedTools,
    })
    await fixture.start()
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(fixture.childEndpoint.activeTools().sort()).toEqual([
      'ast_grep',
      'bash',
      'glob',
      'grep',
      'read',
      'web_search',
      'yield',
    ])
    const result = { findings: [], specRows: [] }
    expect(await fixture.yieldValue(result)).toBeUndefined()
    await fixture.terminal(result)
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it('projects available pinned builtins from an ambient SDK initialization without granting ambient tools', async () => {
    const fixture = await setup({ init: { tools: sdkTools }, registry: sdkRegistry, initialTools: sdkTools })
    await fixture.start()
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(fixture.childEndpoint.activeTools().sort()).toEqual(['ast_grep', 'glob', 'grep', 'read', 'yield'])
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong provenance', sdkRegistry.map((tool) => (tool.name === 'read' ? { ...tool, source: 'extension' } : tool))],
    ['duplicate builtin', [...sdkRegistry, { name: 'read', source: 'builtin' }]],
    ['missing builtin yield', sdkRegistry.filter((tool) => tool.name !== 'yield')],
    ['non-builtin yield', sdkRegistry.map((tool) => (tool.name === 'yield' ? { ...tool, source: 'extension' } : tool))],
  ])('blocks projection with %s before provider or tools', async (_label, registry) => {
    const fixture = await setup({ init: { tools: sdkTools }, registry, initialTools: sdkTools })
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('blocks a tool injected after the SDK tool projection', async () => {
    const fixture = await setup({ init: { tools: sdkTools }, registry: sdkRegistry, initialTools: sdkTools })
    await fixture.start()
    expect(fixture.childEndpoint.activeTools().sort()).toEqual(['ast_grep', 'glob', 'grep', 'read', 'yield'])
    fixture.childEndpoint.addTool('ambient_injected')
    expect(await fixture.yieldValue()).toMatchObject({ block: true })
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('accepts an admitted spawn across distinct root and child event buses', async () => {
    const fixture = await setup()
    await fixture.start()
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it('conserves the guarded yield through completed lifecycle and child shutdown before the root result', async () => {
    const fixture = await setup()
    await fixture.start()
    expect(await fixture.yieldValue()).toBeUndefined()
    fixture.lifecycle({ status: 'completed' })
    await fixture.childEndpoint.emit('session_shutdown', { type: 'session_shutdown' }, fixture.child)
    await fixture.terminal()
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing init', { init: null }],
    ['wrong agent in init', { init: { agent: 'other' } }],
    ['wrong task in init', { init: { task: 'different task' } }],
    ['wrong schema', { init: { outputSchema: { type: 'string' } } }],
    ['malformed tools', { init: { tools: [...tools, 42] } }],
    ['unexpected spawn grant', { init: { spawns: '*' } }],
    ['unexpected advisor', { init: { advisor: 'on' } }],
    ['wrong spawn identity', { id: 'other-child' }],
    ['wrong parent', { parentId: 'other-root' }],
    ['missing lifecycle', { lifecycle: null }],
    ['missing spawn', { spawn: false }],
  ] as const)('cancels before provider or tools with %s', async (_label, options) => {
    const fixture = await setup(options)
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['true detached', { detached: true }],
    ['undefined detached', { detached: undefined }],
    ['nonboolean detached', { detached: 'false' }],
    ['wrong parent call', { parentToolCallId: 'other-call' }],
    ['wrong index', { index: 1 }],
    ['wrong id', { id: 'other-child' }],
    ['wrong agent', { agent: 'other-agent' }],
    ['wrong file', { sessionFile: '/other/child.jsonl' }],
    ['missing file', { sessionFile: undefined }],
  ])('cancels a child with %s in the lifecycle binding', async (_label, lifecycle) => {
    const fixture = await setup({ lifecycle })
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it('cancels when detached is absent from the lifecycle event', async () => {
    const fixture = await setup({ omitDetached: true })
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it('cancels when duplicate lifecycle announcements poison the binding', async () => {
    const fixture = await setup()
    fixture.lifecycle()
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
  })

  it('cancels a second child attempting to bind an already bound lifecycle', async () => {
    const fixture = await setup()
    await fixture.start()
    const duplicateEndpoint = endpoint(eventBus())
    const duplicateAbort = vi.fn()
    const duplicate = { ...fixture.child, abort: duplicateAbort }
    await duplicateEndpoint.emit('session_start', { type: 'session_start' }, duplicate)
    expect(duplicateAbort).not.toHaveBeenCalled()
    await duplicateEndpoint.emit(
      'before_agent_start',
      { type: 'before_agent_start', prompt: taskText, systemPrompt: ['original SDK prompt'] },
      duplicate,
    )
    expect(duplicateAbort).toHaveBeenCalledTimes(1)
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it('cancels if the root switches while child tool setup is pending', async () => {
    const pending = Promise.withResolvers<void>()
    const settingUp = Promise.withResolvers<void>()
    const fixture = await setup({
      beforeSetTools: async () => {
        settingUp.resolve()
        await pending.promise
      },
    })
    const start = fixture.start()
    await settingUp.promise
    await fixture.rootEndpoint.emit('session_switch', { type: 'session_switch' }, fixture.root)
    pending.resolve()
    await start
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it('cancels a stale batch before starting the child', async () => {
    const fixture = await setup()
    await fixture.rootEndpoint.emit('session_switch', { type: 'session_switch' }, fixture.root)
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it('does not rebind a stale child when the switched root admits a new batch', async () => {
    const fixture = await setup()
    await fixture.rootEndpoint.emit('session_switch', { type: 'session_switch' }, fixture.root)
    const { prepared, directory } = preparedBatch()
    const root = { ...fixture.root, sessionManager: { getSessionId: () => 'new-root-session' } }
    await fixture.rootEndpoint.emit('session_start', { type: 'session_start' }, root)
    fixture.rootEndpoint.controller.activate(prepared, { onComplete: vi.fn(), onStop: vi.fn() })
    await fixture.rootEndpoint.emit(
      'tool_call',
      {
        type: 'tool_call',
        toolName: 'task',
        toolCallId: 'new-call',
        input: fixture.rootEndpoint.controller.wire(prepared),
      },
      root,
    )
    expect(
      await fixture.rootEndpoint.emit(
        'before_subagent_spawn',
        { type: 'before_subagent_spawn', invocationKind: 'task', agent, patterns: [], spawnKey: childId },
        root,
      ),
    ).toBeUndefined()
    const sessionFile = join(directory, 'new-child.jsonl')
    fixture.bus.emit('task:subagent:lifecycle', {
      status: 'started',
      id: childId,
      agent,
      index: 0,
      parentToolCallId: 'new-call',
      sessionFile,
      detached: false,
    })
    await fixture.start()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    const newEndpoint = endpoint(eventBus())
    const abort = vi.fn()
    const child = {
      ...fixture.child,
      abort,
      sessionManager: {
        ...fixture.child.sessionManager,
        getSessionId: () => 'new-child-session',
        getSessionFile: () => sessionFile,
      },
    }
    await newEndpoint.emit('session_start', { type: 'session_start' }, child)
    const result = await newEndpoint.emit(
      'before_agent_start',
      { type: 'before_agent_start', prompt: taskText, systemPrompt: ['original SDK prompt'] },
      child,
    )
    expect(abort).not.toHaveBeenCalled()
    expect(result).toMatchObject({ systemPrompt: expect.any(Array) })
  })

  it('does not cancel or block the public generic R-adversarial role', async () => {
    const fixture = await setup({ lifecycle: null })
    const unrelatedEndpoint = endpoint(eventBus())
    const unrelated = { ...fixture.child, agent: { ...fixture.child.agent, name: 'R-adversarial' } }
    await unrelatedEndpoint.emit('session_start', { type: 'session_start' }, unrelated)
    await unrelatedEndpoint.emit(
      'before_agent_start',
      { type: 'before_agent_start', prompt: taskText, systemPrompt: ['original SDK prompt'] },
      unrelated,
    )
    expect(fixture.abort).not.toHaveBeenCalled()
    const event = { type: 'tool_call', toolName: 'read', toolCallId: 'unrelated-call', input: { path: 'file' } }
    expect(await unrelatedEndpoint.emit('tool_call', event, unrelated)).toBeUndefined()
  })

  it.each(['prompt', 'tool provenance', 'extra tool', 'unexpected context', 'stale session'])(
    'refuses a child after %s changes',
    async (mutation) => {
      const fixture = await setup()
      await fixture.start()
      if (mutation === 'prompt') fixture.setPrompt(['modified prompt'])
      if (mutation === 'tool provenance') fixture.childEndpoint.setSource('read', 'extension')
      if (mutation === 'extra tool') fixture.childEndpoint.addTool('bash')
      if (mutation === 'stale session') fixture.setSession('replaced-session')
      if (mutation === 'unexpected context')
        await fixture.childEndpoint.emit(
          'context',
          {
            type: 'context',
            messages: [
              { role: 'user', content: taskText },
              { role: 'custom', content: 'injected instructions' },
            ],
          },
          fixture.child,
        )
      if (mutation === 'unexpected context') {
        expect(fixture.abort).toHaveBeenCalledTimes(1)
        await fixture.yieldValue()
        expect(fixture.runtime.tool).not.toHaveBeenCalled()
        expect(fixture.runtime.yield).not.toHaveBeenCalled()
        expect(
          await fixture.childEndpoint.emit(
            'tool_call',
            { type: 'tool_call', toolName: 'yield', toolCallId: 'after-abort', input: { data } },
            fixture.child,
          ),
        ).toMatchObject({ block: true })
      } else {
        expect(await fixture.yieldValue()).toMatchObject({ block: true })
      }
      await fixture.terminal()
      expect(fixture.onComplete).not.toHaveBeenCalled()
      expect(fixture.onStop).toHaveBeenCalledTimes(1)
    },
  )

  it('refuses forged public yield frames and a successful terminal without a guarded child yield', async () => {
    const fixture = await setup()
    await fixture.start()
    fixture.bus.emit('task:subagent:event', {
      id: childId,
      event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'forged', args: { data } },
    })
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('refuses terminal data that differs from the guarded yield', async () => {
    const fixture = await setup()
    await fixture.start()
    await fixture.yieldValue()
    await fixture.terminal({ findings: [{ title: 'forged' }] })
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('refuses a terminal child identity different from the spawned and guarded child', async () => {
    const fixture = await setup()
    await fixture.start()
    await fixture.yieldValue()
    await fixture.terminal(data, 'other-child')
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('cannot complete a child after the root session switches', async () => {
    const fixture = await setup()
    await fixture.start()
    await fixture.yieldValue()
    await fixture.rootEndpoint.emit('session_switch', { type: 'session_switch' }, fixture.root)
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })
})
