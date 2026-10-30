import { randomUUID } from 'node:crypto'
import type { ExtensionContext, ToolSession } from '@oh-my-pi/pi-coding-agent'
import type { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session'
import type { AgentOutputManager } from '@oh-my-pi/pi-coding-agent/task/output-manager'
import type { Semaphore } from '@oh-my-pi/pi-coding-agent/task/parallel'
import type { NativeBatch, NativeExtension } from './contracts.ts'
import { executeNativeTask } from './native-task-execution.ts'

type Root = AgentSession
type CapturedRoot = {
  root: Root
  registry: AgentRegistry
  providerSessionId: string
  costGate: Root['costGate'] | undefined
  current: () => boolean
}
const rootResources = new WeakMap<
  Root,
  { semaphore: Semaphore; output: AgentOutputManager; file: string | null; active: Set<AbortController> }
>()

/** Bind to the actual root session and provider identity, not a newly constructed SDK session. */
async function capture(ctx: ExtensionContext): Promise<CapturedRoot | null> {
  if (ctx.agent.kind !== 'main' || ctx.agent.depth !== 0) return null
  const { AgentRegistry } = await import('@oh-my-pi/pi-coding-agent/registry/agent-registry')
  const registry = AgentRegistry.global()
  const ref = registry.get(ctx.agent.id)
  const root = ref?.session
  if (!ref || !root || ref.kind !== 'main' || root.modelRegistry !== ctx.modelRegistry) return null
  const modelRegistry = ctx.modelRegistry
  const registrySessionFile = ref.sessionFile
  const sessionId = ctx.sessionManager.getSessionId()
  const providerSessionId = root.agent.sessionId
  if (typeof providerSessionId !== 'string' || providerSessionId.length === 0) return null
  const costGate = root.costGate
  const sessionFile = ctx.sessionManager.getSessionFile()
  const cwd = ctx.cwd
  const current = () =>
    registry.get(ctx.agent.id) === ref &&
    ref.session === root &&
    !root.isDisposed &&
    !root.isSessionTransitioning &&
    ctx.agent.kind === 'main' &&
    ctx.agent.depth === 0 &&
    ctx.modelRegistry === modelRegistry &&
    root.modelRegistry === modelRegistry &&
    ctx.sessionManager.getSessionId() === sessionId &&
    root.sessionManager.getSessionId() === sessionId &&
    ctx.sessionManager.getSessionFile() === sessionFile &&
    root.sessionManager.getSessionFile() === sessionFile &&
    ref.sessionFile === registrySessionFile &&
    ctx.cwd === cwd &&
    root.sessionManager.getCwd() === cwd &&
    root.agent.sessionId === providerSessionId &&
    root.costGate === costGate
  return current() ? { root, registry, providerSessionId, costGate, current } : null
}

export async function captureNativeRoot(ctx: ExtensionContext): Promise<{ current: () => boolean } | null> {
  const captured = await capture(ctx)
  return captured ? { current: captured.current } : null
}

export type Options = {
  ctx: ExtensionContext
  pi: NativeExtension
  batch: NativeBatch
  toolCallId: string
  signal: AbortSignal
  current: () => boolean
  bindChild: (id: string, index: number, model: { provider: string; id: string }) => boolean
}

function fulfilledError(value: { exitCode: unknown; error?: unknown; aborted?: unknown }): unknown {
  if (value.exitCode !== 0 || value.error || value.aborted)
    return value.error ?? (value.aborted ? 'subagent aborted' : `subagent exited ${value.exitCode}`)
  return undefined
}

function collectOutcomes<T extends { exitCode: unknown; error?: unknown; aborted?: unknown }>(
  settled: PromiseSettledResult<T>[],
): { results: unknown[]; errors: string[] } {
  const results: unknown[] = []
  const errors: string[] = []
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value)
      const error = fulfilledError(outcome.value)
      if (error !== undefined) errors.push(`${index}: ${error}`)
    } else errors.push(`${index}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
  }
  return { results, errors }
}

/** Execute only actual SDK subprocesses; preflight and dispatch failures are errors, never fabricated results. */
export async function executeNativeBatch(options: Options): Promise<{ results: unknown[]; errors: string[] }> {
  const captured = await capture(options.ctx)
  if (!captured) return { results: [], errors: ['native root session unavailable'] }
  const { root, registry } = captured
  const approvedRoles = [...new Set(options.batch.tasks.tasks.map((task) => task.agent))].join(',')
  const session: ToolSession = {
    cwd: root.sessionManager.getCwd(),
    hasUI: options.ctx.hasUI,
    settings: root.settings,
    costGate: captured.costGate,
    additionalDirectories: root.sessionManager.getAdditionalDirectories(),
    sessionManager: root.sessionManager,
    agentRegistry: registry,
    taskDepth: 0,
    eventBus: options.pi.events,
    authStorage: root.modelRegistry.authStorage,
    modelRegistry: root.modelRegistry,
    asyncJobManager: root.asyncJobManager,
    getSessionFile: () => root.sessionManager.getSessionFile() ?? null,
    getSessionId: () => root.sessionManager.getSessionId(),
    getAgentId: () => options.ctx.agent.id,
    getSessionSpawns: () => approvedRoles,
    getSessionAgents: () => root.getSessionAgents(),
    effectiveExtensionRoots: () => root.effectiveExtensionRoots,
    getPlanModeState: () => root.getPlanModeState(),
    getArtifactManager: () => root.sessionManager.getArtifactManager(),
    getHindsightSessionState: () => root.getHindsightSessionState(),
    getMnemopiSessionState: () => root.getMnemopiSessionState(),
    getServiceTierByFamily: () => root.serviceTierByFamily,
    skills: root.skills,
  }
  const ownedTools = options.pi.getAllTools().filter((tool) => tool.name === 'omp_build_execute_native_batch')
  const prepared = root.preparedExtensions
  const source =
    ownedTools.length === 1 && ownedTools[0].sourceInfo?.source === 'extension'
      ? ownedTools[0].sourceInfo.path
      : undefined
  if (
    !source ||
    !prepared?.some(
      (extension) => extension.factory && (extension.path === source || extension.resolvedPath === source),
    )
  )
    return { results: [], errors: ['native child guard extension is not available for rebinding'] }
  // The installed extension is loaded by the host's SDK-aware plugin loader.
  const [
    { resolveConfiguredModelPatterns },
    { runSubprocess },
    { Semaphore },
    { AgentOutputManager },
    { cfgTaskMaxConcurrency },
    { resolveEffectiveSubagentPolicy },
  ] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent/config/model-resolver'),
    import('@oh-my-pi/pi-coding-agent/task/executor'),
    import('@oh-my-pi/pi-coding-agent/task/parallel'),
    import('@oh-my-pi/pi-coding-agent/task/output-manager'),
    import('@oh-my-pi/pi-coding-agent/task/settings'),
    import('@oh-my-pi/pi-coding-agent/task/structured-subagent'),
  ])
  const revocation = new AbortController()
  const signal = AbortSignal.any([options.signal, revocation.signal])
  const alive = () => !signal.aborted && captured.current() && options.current()
  let resources = rootResources.get(root)
  if (!resources) {
    resources = {
      semaphore: new Semaphore(cfgTaskMaxConcurrency.get(root.settings)),
      output: new AgentOutputManager(() => root.sessionManager.getArtifactsDir()),
      file: root.sessionManager.getSessionFile() ?? null,
      active: new Set(),
    }
    rootResources.set(root, resources)
    const owned = resources
    root.addDisposer(() => {
      for (const controller of owned.active) controller.abort(new Error('native root disposed'))
    })
  }
  const currentFile = root.sessionManager.getSessionFile() ?? null
  if (resources.file !== currentFile) {
    resources.output = new AgentOutputManager(() => root.sessionManager.getArtifactsDir())
    resources.file = currentFile
  }
  const { semaphore, output } = resources
  resources.active.add(revocation)
  const unsubscribeRegistry = registry.onChange(() => {
    if (!captured.current()) revocation.abort(new Error('native root replaced'))
  })
  const unsubscribeSession = root.registerSessionChangeCallback(() =>
    revocation.abort(new Error('native root session changed')),
  )
  if (!alive()) revocation.abort(new Error('native batch is no longer current'))
  const namespace = randomUUID()
  const taskContext = {
    options,
    root,
    registry,
    session,
    providerSessionId: captured.providerSessionId,
    signal,
    alive,
    namespace,
    semaphore,
    output,
    cfgTaskMaxConcurrency,
    resolveEffectiveSubagentPolicy,
    resolveConfiguredModelPatterns,
    runSubprocess,
  }
  const settled = await Promise.allSettled(
    options.batch.tasks.tasks.map((task, index) => executeNativeTask(taskContext, task, index)),
  )
  unsubscribeRegistry()
  unsubscribeSession()
  resources.active.delete(revocation)
  return collectOutcomes(settled)
}
