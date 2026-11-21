import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgent } from '../../../../__mocks__/@oh-my-pi/pi-coding-agent/task/agents.ts'
import { announceFeatureBatch } from '../../roxabi/feature-host-native.ts'
import { claimStartActivation, startDispatch } from '../../roxabi/feature-start-executions.ts'
import {
  cleanup as cleanupFeatureHost,
  fixture as featureHost,
  noDelivery,
  start,
} from '../../testing/feature-host-native-interruption-fixture.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch, bridgeHarness, cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { executeOwnedBatch } from '../review-runtime/batch-execution.ts'
import { createNativeReviewPort } from '../review-runtime/port.ts'
import { releaseTaskMask } from '../review-runtime/task-mask-lease.ts'

// Only SDK boundaries are substituted. The plugin's real adapter, controller and callback settlement run.
const sdk = vi.hoisted(() => ({
  registry: { get: vi.fn(), list: vi.fn(), onChange: vi.fn(), awaits: { hold: vi.fn() } },
  policy: vi.fn(),
  route: vi.fn(),
  run: vi.fn(),
  profile: vi.fn(),
}))
vi.mock('@oh-my-pi/pi-coding-agent/registry/agent-registry', () => ({ AgentRegistry: { global: () => sdk.registry } }))
vi.mock('@oh-my-pi/pi-coding-agent/task/structured-subagent', () => ({ resolveEffectiveSubagentPolicy: sdk.policy }))
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

afterEach(() => {
  cleanupFixtureActions()
  cleanupFeatureHost()
  vi.resetAllMocks()
})

function setup() {
  const h = bridgeHarness()
  let active = ['read', 'task', 'omp_build_execute_native_batch']
  const protocol = consultableProtocolOptions()
  const manager = {
    getSessionId: () => 'cleanup-session',
    getSessionFile: () => '/fixture/session.jsonl',
    getArtifactsDir: protocol.getArtifactsDir,
    getCwd: () => '/fixture-root',
    getAdditionalDirectories: () => [],
    getArtifactManager: () => null,
  }
  const model = { provider: 'fixture-provider', id: 'fixture-model' }
  const registry = { authStorage: {} }
  const session = {
    hasBuiltInTool: (name: string) => name === 'task',
    sessionManager: manager,
    modelRegistry: registry,
    agent: { sessionId: 'provider' },
    settings: {},
    skills: [],
    isDisposed: false,
    isSessionTransitioning: false,
    getActiveToolNames: () => [...active],
    getMountedXdevToolNames: () => [],
    getEnabledToolNames: () => [...active],
    runToolRegistryMutation: async (fn: () => Promise<void>) => await fn(),
    setActiveToolPresentation: async (names: string[]) => {
      active = names
    },
    extensionRunner: { emitBeforeSubagentSpawn: async () => undefined },
    getSessionAgents: () => [],
    getPlanModeState: () => null,
    getHindsightSessionState: () => null,
    getMnemopiSessionState: () => null,
    addDisposer() {},
    registerSessionChangeCallback: () => () => {},
    preparedExtensions: [{ path: 'guard', factory: () => {} }],
  }
  const ctx = {
    agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
    cwd: '/fixture-root',
    sessionManager: manager,
    modelRegistry: registry,
    model,
    models: { resolve: () => model, current: () => model },
    localProtocolOptions: protocol,
    isIdle: () => true,
  }
  const ref = { kind: 'main', session, sessionFile: manager.getSessionFile() }
  sdk.registry.get.mockImplementation((id: string) => (id === 'Main' ? ref : undefined))
  sdk.registry.list.mockReturnValue([])
  sdk.registry.onChange.mockReturnValue(() => {})
  sdk.registry.awaits.hold.mockReturnValue(() => {})
  vi.spyOn(h.native, 'getAllTools').mockReturnValue([
    { name: 'omp_build_execute_native_batch', sourceInfo: { source: 'extension', path: 'guard' } },
  ] as never)
  h.controller.observeRootContext(ctx as never)
  const port = createNativeReviewPort(h.native, h.controller)
  return { h, ctx, port }
}

function authorize(prepared: ReturnType<typeof batch>) {
  const task = prepared.tasks.tasks[0]
  const filePath = join(dirname(task.action.snapshot.indexPath), 'plugin', 'agents', `${task.agent}.md`)
  const schema = { type: 'object' }
  const agent = {
    filePath,
    source: 'project',
    systemPrompt: 'prompt',
    tools: ['read'],
    output: schema,
    blocking: true,
    structured: true,
  }
  parseAgent.mockReturnValue(agent)
  sdk.profile.mockResolvedValue({ prompt: 'prompt', tools: ['read'], outputSchema: schema })
  sdk.policy.mockResolvedValue({
    agent,
    effectiveAgent: agent,
    agentName: task.agent,
    schema: { mode: 'strict', source: 'agent', schema },
    modelOverride: ['fixture-provider/fixture-model'],
  })
}

async function run(prepared: ReturnType<typeof batch>, f: ReturnType<typeof setup>) {
  const terminal = Promise.withResolvers<void>()
  f.port.activate(prepared, {
    onComplete: async () => {
      terminal.resolve()
    },
    onStop: async () => {
      terminal.resolve()
    },
  })
  await f.port.announce(prepared)
  const wire = f.h.controller.wire(prepared)
  if (!wire) throw new Error('missing owned batch wire')
  await executeOwnedBatch(f.h.native, f.h.controller, `call-${prepared.operationId}`, wire, undefined, f.ctx as never)
  await terminal.promise
  await releaseTaskMask(f.h.controller, false, prepared)
}

describe('deferred SDK cleanup is batch-scoped', () => {
  it('keeps admitted STARTs non-resolvable regardless of SDK cleanup state', async () => {
    const f = setup()
    const a = batch(['slot-a'])
    a.operationId = 'cleanup-a'
    const b = batch(['slot-b'])
    b.operationId = 'cleanup-b'
    const scope = { repository: 'acme/app', target: 'acme/app#42' }
    const startA = { scope, kind: 'action-receipt' as const, recordId: 'cleanup-start-a' }
    const startB = { scope, kind: 'action-receipt' as const, recordId: 'cleanup-start-b' }
    expect(claimStartActivation(startA, a.operationId)).toBe(true)
    expect(claimStartActivation(startB, b.operationId)).toBe(true)
    const pending = Promise.withResolvers<void>()
    authorize(a)
    sdk.run.mockImplementationOnce(
      async (options: { id: string; index: number; onCleanupDeferred?: (p: Promise<void>) => void }) => {
        options.onCleanupDeferred?.(pending.promise)
        return {
          id: options.id,
          index: options.index,
          agent: 'R-review-adversarial',
          exitCode: 1,
          error: 'child ended',
        }
      },
    )
    try {
      await run(a, f)
      expect(sdk.run).toHaveBeenCalledTimes(1)
      authorize(b)
      sdk.run.mockImplementationOnce(async (options: { id: string; index: number }) => ({
        id: options.id,
        index: options.index,
        agent: 'R-review-adversarial',
        exitCode: 1,
        error: 'child ended',
      }))
      await run(b, f)
      expect(sdk.run).toHaveBeenCalledTimes(2)
      expect(startDispatch(startA)).toEqual({ kind: 'activated', operationId: a.operationId })
      expect(startDispatch(startB)).toEqual({ kind: 'activated', operationId: b.operationId })
      pending.resolve()
      await pending.promise
      expect(startDispatch(startA)).toEqual({ kind: 'activated', operationId: a.operationId })
    } finally {
      pending.resolve()
    }
  })
  it('returns both publisher and notification failures across the actual owned tool boundary', async () => {
    const f = setup()
    const prepared = batch(['slot-a'])
    prepared.operationId = 'publication-boundary'
    const { host } = featureHost(f.h)
    host.native = f.port
    const cause = new Error('original publisher cause')
    const primary = new Error('publisher failed', { cause })
    const notification = new Error('notification failed')
    host.workflow.publishFeatureNativeResult = async () => {
      throw primary
    }
    host.send = async () => {
      throw notification
    }
    authorize(prepared)
    sdk.run.mockImplementationOnce(async (options: { id: string; index: number }) => ({
      id: options.id,
      index: options.index,
      agent: 'R-review-adversarial',
      exitCode: 1,
      error: 'child ended',
    }))
    await announceFeatureBatch('42', prepared, start('publication-boundary-start'), host, noDelivery)
    const wire = f.h.controller.wire(prepared)
    if (!wire) throw new Error('missing owned batch wire')
    try {
      const error = await executeOwnedBatch(
        f.h.native,
        f.h.controller,
        'publication-boundary-call',
        wire,
        undefined,
        f.ctx as never,
      ).then(
        () => null,
        (failure: unknown) => failure,
      )
      expect(error).toBeInstanceOf(AggregateError)
      const aggregate = error as AggregateError
      expect(aggregate.errors).toContain(primary)
      expect(aggregate.errors).toContain(notification)
      expect(aggregate.cause).toBe(primary)
      expect(primary.cause).toBe(cause)
    } finally {
      await releaseTaskMask(f.h.controller, false, prepared)
    }
  })
})
