import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAgent } from '../../../../__mocks__/@oh-my-pi/pi-coding-agent/task/agents.ts'
import { captureNativeRoot, executeNativeBatch } from '../review-runtime/native-sdk-adapter.ts'

// Mock the public SDK module boundaries, not a fabricated child lifecycle.
const sdk = vi.hoisted(() => ({
  registry: { get: vi.fn(), list: vi.fn(), onChange: vi.fn(), awaits: { hold: vi.fn() } },
  policy: vi.fn(),
  route: vi.fn(),
  run: vi.fn(),
  profile: vi.fn(),
}))
vi.mock('@oh-my-pi/pi-coding-agent/registry/agent-registry', () => ({ AgentRegistry: { global: () => sdk.registry } }))
vi.mock('@oh-my-pi/pi-coding-agent/task/structured-subagent', () => ({ resolveEffectiveSubagentPolicy: sdk.policy }))
// Redirect rather than a factory: both tasks import this boundary concurrently.
vi.mock('@oh-my-pi/pi-coding-agent/task/agents')
vi.mock('@oh-my-pi/pi-coding-agent/config/model-resolver', () => ({ resolveConfiguredModelPatterns: sdk.route }))
vi.mock('@oh-my-pi/pi-coding-agent/task/executor', () => ({ runSubprocess: sdk.run }))
vi.mock('@oh-my-pi/pi-coding-agent/task/parallel', () => ({
  Semaphore: class {
    async acquire() {}
    resize() {}
    release() {}
  },
}))
vi.mock('@oh-my-pi/pi-coding-agent/task/output-manager', () => ({
  AgentOutputManager: class {
    async reserve() {}
    async allocate(id: string) {
      return id
    }
  },
}))
vi.mock('@oh-my-pi/pi-coding-agent/task/settings', () => ({ cfgTaskMaxConcurrency: { get: () => 4 } }))
vi.mock('../review-runtime/executed-child-profile.ts', () => ({ loadPinnedProfile: sdk.profile }))

let dir: string
beforeEach(async () => {
  vi.resetAllMocks()
  dir = await mkdtemp(join(tmpdir(), 'native-adapter-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const pinned = join(dir, 'plugin', 'agents', 'reviewer.md')
  await mkdir(join(dir, 'plugin', 'agents'), { recursive: true })
  await writeFile(pinned, 'pinned profile')
  const schema = { type: 'object' }
  const agent = {
    filePath: pinned,
    source: 'project',
    systemPrompt: 'prompt',
    tools: ['read'],
    output: schema,
    blocking: true,
    structured: true,
  }
  const policy = {
    agent,
    effectiveAgent: agent,
    agentName: 'reviewer',
    schema: { mode: 'strict', source: 'agent', schema },
    modelOverride: ['trusted/model'],
  }
  sdk.profile.mockResolvedValue({ prompt: 'prompt', tools: ['read'], outputSchema: schema })
  parseAgent.mockReturnValue(agent)
  sdk.policy.mockResolvedValue(policy)
  sdk.run.mockResolvedValue({ exitCode: 0, value: 'done' })
  const release = vi.fn()
  sdk.registry.awaits.hold.mockReturnValue(release)
  sdk.registry.list.mockReturnValue([])
  sdk.registry.onChange.mockReturnValue(() => {})
  const manager = {
    getSessionId: () => 'session',
    getSessionFile: () => join(dir, 'session.jsonl'),
    getArtifactsDir: vi.fn<() => string | null>(() => join(dir, 'custom-artifacts')),
    getCwd: () => dir,
    getAdditionalDirectories: () => [],
    getArtifactManager: () => null,
  }
  const hook = vi.fn().mockResolvedValue(undefined)
  const settings = { rootScoped: true }
  const root = {
    sessionManager: manager,
    agent: { sessionId: 'provider-session' },
    settings,
    costGate: { generation: 1 },
    modelRegistry: { authStorage: {} },
    skills: [],
    extensionRunner: { emitBeforeSubagentSpawn: hook },
    getSessionAgents: () => [],
    getPlanModeState: () => null,
    getHindsightSessionState: () => null,
    getMnemopiSessionState: () => null,
    addDisposer: () => {},
    registerSessionChangeCallback: () => () => {},
    preparedExtensions: [{ path: 'guard', factory: () => {} }],
  }
  const ref = { kind: 'main', session: root, sessionFile: manager.getSessionFile() }
  sdk.registry.get.mockImplementation((id: string) => (id === 'root' ? ref : undefined))
  const resolve = vi.fn().mockReturnValue({ provider: 'trusted', id: 'model' })
  const ctx = {
    agent: { kind: 'main', depth: 0, id: 'root' },
    cwd: dir,
    modelRegistry: root.modelRegistry,
    sessionManager: manager,
    models: { resolve },
  }
  const bindChild = vi.fn().mockReturnValue(true)
  const pin = {
    root: 'plugin',
    repository: 'repo',
    commit: 'commit',
    files: [
      {
        path: 'plugin/agents/reviewer.md',
        repository: 'repo',
        commit: 'commit',
        digest: createHash('sha256').update('pinned profile').digest('hex'),
      },
    ],
  }
  const task = {
    name: 'one',
    agent: 'reviewer',
    task: 'inspect',
    solutionSpace: '',
    action: { snapshot: { indexPath: join(dir, 'index.json') }, inputs: { manifest: { plugin: pin } } },
  }
  const options = {
    ctx,
    pi: {
      events: {},
      getAllTools: () => [
        { name: 'omp_build_execute_native_batch', sourceInfo: { source: 'extension', path: 'guard' } },
      ],
    },
    batch: { operationId: 'op', tasks: { context: 'context', tasks: [task] } },
    toolCallId: 'call',
    signal: new AbortController().signal,
    current: () => true,
    bindChild,
  } as unknown as Parameters<typeof executeNativeBatch>[0]
  return { options, ctx, root, ref, settings, hook, resolve, bindChild, policy, agent, pinned, release }
}

describe('native SDK adapter policy and authorization', () => {
  it('creates the root artifact directory before dispatch', async () => {
    const f = await fixture()
    await executeNativeBatch(f.options)
    expect((await stat(join(dir, 'custom-artifacts'))).isDirectory()).toBe(true)
  })

  it('refuses dispatch when child binding is rejected', async () => {
    const f = await fixture()
    f.bindChild.mockReturnValue(false)
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('native child binding rejected')])
    expect(f.hook).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('refuses dispatch when the root has no artifact directory', async () => {
    const f = await fixture()
    f.root.sessionManager.getArtifactsDir.mockReturnValue(null)
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('native root session has no artifact directory')])
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('rejects dispatch when the owned child guard cannot be rebound', async () => {
    const f = await fixture()
    f.root.preparedExtensions = []
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual([expect.stringContaining('guard extension is not available')])
    expect(sdk.policy).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'malformed'] as const)('fails closed for %s policy', async (kind) => {
    const f = await fixture()
    if (kind === 'unavailable') sdk.policy.mockRejectedValue(new Error('policy unavailable'))
    else sdk.policy.mockResolvedValue({ agent: {} })
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([
      expect.stringContaining(kind === 'unavailable' ? 'policy unavailable' : 'pinned agent policy unavailable'),
    ])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(f.hook).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('rejects a discovered profile shadowing the pinned bytes', async () => {
    const f = await fixture()
    const shadow = join(dir, 'shadow.md')
    await writeFile(shadow, 'different profile')
    f.policy.agent = { ...f.agent, filePath: shadow }
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual([expect.stringContaining('bytes differ')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it.each([
    ['prompt', { systemPrompt: 'different prompt' }],
    ['tools', { tools: ['write'] }],
    ['output schema', { output: { type: 'string' } }],
  ])('rejects parsed and selected %s differing from the pinned profile', async (_field, difference) => {
    const f = await fixture()
    f.policy.agent = { ...f.agent, ...difference }
    f.policy.effectiveAgent = { ...f.agent, ...difference }
    parseAgent.mockReturnValue({ ...f.agent, ...difference })
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('discovered agent behavior differs from pinned profile')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it.each([
    ['prompt', { systemPrompt: 'different prompt' }],
    ['tools', { tools: ['write'] }],
    ['output schema', { output: { type: 'string' } }],
    ['blocking', { blocking: false }],
    ['structured', { structured: false }],
  ])('rejects an effective agent with different %s', async (_field, difference) => {
    const f = await fixture()
    f.policy.effectiveAgent = { ...f.agent, ...difference }
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('discovered agent behavior differs from pinned profile')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it.each([
    ['prompt', { systemPrompt: 'different parsed prompt' }],
    ['tools', { tools: ['write'] }],
    ['output schema', { output: { type: 'string' } }],
  ])('rejects a selected agent differing from the independently parsed %s', async (_field, difference) => {
    const f = await fixture()
    parseAgent.mockReturnValue({ ...f.agent, ...difference })
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('discovered agent behavior differs from pinned profile')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('rejects a policy schema that differs from the pinned schema', async () => {
    const f = await fixture()
    f.policy.schema = { mode: 'strict', source: 'agent', schema: { type: 'string' } }
    const result = await executeNativeBatch(f.options)
    expect(result.results).toEqual([])
    expect(result.errors).toEqual([expect.stringContaining('discovered agent behavior differs from pinned profile')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('rejects an unresolved root model before binding or invoking hooks', async () => {
    const f = await fixture()
    f.resolve.mockReturnValue(undefined)
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual([expect.stringContaining('did not resolve an authorized model')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(f.hook).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('captures a moved root despite stale registry file metadata and an equivalent context wrapper', async () => {
    const f = await fixture()
    f.ctx.cwd = join(dir, 'moved')
    f.root.sessionManager.getCwd = () => join(dir, 'moved')
    f.root.sessionManager.getSessionFile = () => join(dir, 'moved', 'session.jsonl')
    const captured = await captureNativeRoot({ ...f.options.ctx })
    expect(captured).not.toBeNull()
    expect(captured?.current()).toBe(true)
  })

  it.each(['file', 'journal', 'cwd', 'provider', 'ref', 'session', 'modelRegistry', 'metadata', 'costGate'] as const)(
    'revokes a moved root after %s changes',
    async (identity) => {
      const f = await fixture()
      f.ctx.cwd = join(dir, 'moved')
      f.root.sessionManager.getCwd = () => join(dir, 'moved')
      f.root.sessionManager.getSessionFile = () => join(dir, 'moved', 'session.jsonl')
      const captured = await captureNativeRoot(f.options.ctx)
      expect(captured?.current()).toBe(true)
      const changes = {
        file: () => {
          f.root.sessionManager.getSessionFile = () => join(dir, 'other.jsonl')
        },
        journal: () => {
          f.root.sessionManager.getSessionId = () => 'other'
        },
        cwd: () => {
          f.root.sessionManager.getCwd = () => join(dir, 'other')
        },
        provider: () => {
          f.root.agent.sessionId = 'other'
        },
        ref: () => {
          sdk.registry.get.mockReturnValue({ ...f.ref })
        },
        session: () => {
          f.ref.session = { ...f.root }
        },
        modelRegistry: () => {
          f.ctx.modelRegistry = f.root.modelRegistry = { authStorage: {} }
        },
        metadata: () => {
          f.ref.sessionFile = join(dir, 'other-metadata.jsonl')
        },
        costGate: () => {
          f.root.costGate = { generation: 2 }
        },
      }
      changes[identity]()
      expect(captured?.current()).toBe(false)
    },
  )

  it.each(['isDisposed', 'isSessionTransitioning'] as const)('rejects a root with %s set', async (state) => {
    const f = await fixture()
    Reflect.set(f.root, state, true)
    expect(await captureNativeRoot(f.options.ctx)).toBeNull()
    expect(await executeNativeBatch(f.options)).toEqual({ results: [], errors: ['native root session unavailable'] })
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('revokes a captured root when the registry generation changes', async () => {
    const f = await fixture()
    const captured = await captureNativeRoot(f.options.ctx)
    expect(captured?.current()).toBe(true)
    sdk.registry.get.mockReturnValue({ ...f.ref })
    expect(captured?.current()).toBe(false)
  })

  it.each([undefined, ''])('rejects a missing provider session ID %j', async (id) => {
    const f = await fixture()
    Reflect.set(f.root.agent, 'sessionId', id)
    expect(await captureNativeRoot(f.options.ctx)).toBeNull()
    expect(await executeNativeBatch(f.options)).toEqual({ results: [], errors: ['native root session unavailable'] })
    expect(sdk.policy).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('revokes capture and prevents dispatch when the root cost gate changes', async () => {
    const f = await fixture()
    const captured = await captureNativeRoot(f.options.ctx)
    expect(captured?.current()).toBe(true)
    sdk.policy.mockImplementation(async () => {
      f.root.costGate = { generation: 2 }
      return f.policy
    })
    const result = await executeNativeBatch(f.options)
    expect(captured?.current()).toBe(false)
    expect(result.errors).toEqual([expect.stringContaining('no longer current')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('does not dispatch if the root generation changes during policy resolution', async () => {
    const f = await fixture()
    sdk.policy.mockImplementation(async () => {
      sdk.registry.get.mockReturnValue({ ...f.ref })
      return f.policy
    })
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual([expect.stringContaining('no longer current')])
    expect(f.bindChild).not.toHaveBeenCalled()
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it('rejects an unresolved or blocked hook route without dispatching', async () => {
    const f = await fixture()
    f.hook.mockResolvedValueOnce({ model: 'missing' }).mockResolvedValueOnce({ block: true, reason: 'denied' })
    sdk.route.mockReturnValue([])
    expect((await executeNativeBatch(f.options)).errors).toEqual([expect.stringContaining('unresolved model route')])
    expect((await executeNativeBatch(f.options)).errors).toEqual([expect.stringContaining('denied')])
    expect(sdk.run).not.toHaveBeenCalled()
  })

  it.each([{ provider: 'shadow', id: 'model' }, { provider: 'trusted', id: 'other' }, undefined])(
    'rejects a hook route resolving to %j',
    async (model) => {
      const f = await fixture()
      f.hook.mockResolvedValue({ model: 'alias' })
      sdk.route.mockReturnValue(['alias/model'])
      f.resolve.mockReturnValueOnce({ provider: 'trusted', id: 'model' }).mockReturnValueOnce(model)
      const result = await executeNativeBatch(f.options)
      expect(result.errors).toEqual([expect.stringContaining('changed the authorized model')])
      expect(sdk.run).not.toHaveBeenCalled()
    },
  )

  it('preserves partial outcomes and reports failed executor results', async () => {
    const f = await fixture()
    f.options.batch.tasks.tasks.push({ ...f.options.batch.tasks.tasks[0], name: 'two' })
    sdk.run.mockImplementation(async ({ index }: { index: number }) =>
      index === 0 ? { exitCode: 0 } : { exitCode: 1, error: 'failed' },
    )
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual(['1: failed'])
    expect(result.results).toEqual([{ exitCode: 0 }, { exitCode: 1, error: 'failed' }])
  })

  it('conserves the completed result when another executor rejects', async () => {
    const f = await fixture()
    f.options.batch.tasks.tasks.push({ ...f.options.batch.tasks.tasks[0], name: 'two' })
    sdk.run.mockImplementation(async ({ index }: { index: number }) => {
      if (index === 1) throw new Error('executor rejected')
      return { exitCode: 0 }
    })
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual(['1: executor rejected'])
    expect(result.results).toEqual([{ exitCode: 0 }])
  })

  it('does not dispatch after cancellation in the spawn hook', async () => {
    const f = await fixture()
    const abort = new AbortController()
    f.options.signal = abort.signal
    f.hook.mockImplementation(async () => {
      abort.abort()
    })
    const result = await executeNativeBatch(f.options)
    expect(result.errors).toEqual([expect.stringContaining('no longer current')])
    expect(sdk.run).not.toHaveBeenCalled()
  })
})
