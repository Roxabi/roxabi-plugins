import { mkdir } from 'node:fs/promises'
import type { ToolSession } from '@oh-my-pi/pi-coding-agent'
import type { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session'
import type { AgentOutputManager } from '@oh-my-pi/pi-coding-agent/task/output-manager'
import type { Semaphore } from '@oh-my-pi/pi-coding-agent/task/parallel'
import type { EffectiveSubagentPolicy } from '@oh-my-pi/pi-coding-agent/task/structured-subagent'
import type { NativeTask } from './contracts.ts'
import { verifySelectedAgent } from './native-agent-verification.ts'
import type { Options } from './native-sdk-adapter.ts'

export type TaskContext = {
  options: Options
  root: AgentSession
  registry: AgentRegistry
  session: ToolSession
  providerSessionId: string
  signal: AbortSignal
  alive: () => boolean
  namespace: string
  semaphore: Semaphore
  output: AgentOutputManager
  cfgTaskMaxConcurrency: typeof import('@oh-my-pi/pi-coding-agent/task/settings').cfgTaskMaxConcurrency
  resolveEffectiveSubagentPolicy: typeof import('@oh-my-pi/pi-coding-agent/task/structured-subagent').resolveEffectiveSubagentPolicy
  resolveConfiguredModelPatterns: typeof import('@oh-my-pi/pi-coding-agent/config/model-resolver').resolveConfiguredModelPatterns
  runSubprocess: typeof import('@oh-my-pi/pi-coding-agent/task/executor').runSubprocess
}

const deferredCleanups = new Set<Promise<void>>()

async function authorizeSpawn(context: TaskContext, policy: EffectiveSubagentPolicy, id: string, index: number) {
  const { options, root, session, signal, resolveConfiguredModelPatterns } = context
  const model = policy.modelOverride?.length ? options.ctx.models.resolve(policy.modelOverride.join(',')) : undefined
  if (!model) throw new Error('SDK policy did not resolve an authorized model')
  const authorized = { provider: model.provider, id: model.id }
  if (!options.bindChild(id, index, authorized)) throw new Error('native child binding rejected')
  const runner = root.extensionRunner
  if (!runner) throw new Error('root extension runner unavailable')
  const hook = await runner.emitBeforeSubagentSpawn(
    {
      type: 'before_subagent_spawn',
      agent: policy.agentName,
      invocationKind: 'task',
      modelRole: policy.modelRole,
      patterns: policy.modelOverride ?? [],
      spawnKey: id,
    },
    signal,
  )
  if (hook?.block) throw new Error(hook.reason ?? 'subagent spawn blocked')
  let modelOverride = policy.modelOverride
  if (hook?.model !== undefined) {
    const replacement = resolveConfiguredModelPatterns(hook.model, session.settings)
    if (!replacement.length) throw new Error('spawn hook supplied an unresolved model route')
    const routed = options.ctx.models.resolve(replacement.join(','))
    if (!routed || routed.provider !== authorized.provider || routed.id !== authorized.id)
      throw new Error('spawn hook changed the authorized model')
    modelOverride = replacement
  }
  return { hook, modelOverride }
}

async function prepareArtifacts(root: AgentSession, alive: () => boolean) {
  if (!alive()) throw new Error('native batch is no longer current')
  const sessionFile = root.sessionManager.getSessionFile()
  const artifactsDir = root.sessionManager.getArtifactsDir()
  if (!sessionFile || !artifactsDir) throw new Error('native root session has no artifact directory')
  await mkdir(artifactsDir, { recursive: true })
  if (!alive()) throw new Error('native batch is no longer current')
  return { sessionFile, artifactsDir }
}

export async function executeNativeTask(context: TaskContext, task: NativeTask, index: number) {
  const {
    options,
    root,
    registry,
    session,
    providerSessionId,
    signal,
    alive,
    namespace,
    semaphore,
    output,
    cfgTaskMaxConcurrency,
    resolveEffectiveSubagentPolicy,
    runSubprocess,
  } = context
  const invokedAt = Date.now()
  semaphore.resize(cfgTaskMaxConcurrency.get(root.settings))
  await semaphore.acquire(signal)
  try {
    if (!alive()) throw new Error('native batch is no longer current')
    await output.reserve(registry.list().map((ref) => ref.id))
    const id = await output.allocate(`omp-${namespace}-${index}`)
    if (!alive() || registry.get(id)) throw new Error('native child identity unavailable')
    const request = {
      session,
      invocationKind: 'task' as const,
      assignment: task.task,
      context: options.batch.tasks.context,
      agent: task.agent,
      identity: { id },
      index,
      parentToolCallId: options.toolCallId,
      detached: false,
      structured: true,
      schemaMode: 'strict' as const,
      solutionSpace: task.solutionSpace,
      signal,
      enableLsp: false,
      enableIrc: false,
    }
    const policy = await resolveEffectiveSubagentPolicy(request)
    await verifySelectedAgent(task, policy)
    if (!alive()) throw new Error('native batch is no longer current')
    const { hook, modelOverride } = await authorizeSpawn(context, policy, id, index)
    const { sessionFile, artifactsDir } = await prepareArtifacts(root, alive)
    const release = registry.awaits.hold(options.ctx.agent.id, [id], { interruptible: false })
    try {
      return await runSubprocess({
        cwd: session.cwd,
        costGate: session.costGate,
        additionalDirectories: session.additionalDirectories,
        credentialSourceSessionId: providerSessionId,
        agent: policy.effectiveAgent,
        task: `Complete assignment thoroughly:\n\n${task.task.trim()}`,
        assignment: task.task.trim(),
        context: options.batch.tasks.context.trim() || undefined,
        id,
        index,
        parentToolCallId: options.toolCallId,
        detached: false,
        keepAlive: false,
        taskDepth: session.taskDepth ?? 0,
        invokedAt,
        acquiredAt: Date.now(),
        modelOverride,
        modelRole: policy.modelRole,
        modelRoute: hook?.note,
        serviceTierOverride: policy.serviceTierOverride,
        compactionThresholdOverride: policy.compactionThresholdOverride,
        oauthAccountPools: policy.oauthAccountPools,
        thinkingLevel: policy.effectiveAgent.thinkingLevel,
        solutionSpace: task.solutionSpace.trim() || undefined,
        structured: true,
        outputSchemaSource: 'agent',
        outputSchema: policy.schema.schema,
        outputSchemaOverridesAgent: policy.schema.outputSchemaOverridesAgent,
        outputSchemaMode: 'strict',
        sessionFile,
        persistArtifacts: true,
        artifactsDir,
        enableLsp: false,
        enableIrc: false,
        enableMCP: false,
        restrictToolNames: true,
        signal,
        onCleanupDeferred: (completion) => {
          deferredCleanups.add(completion)
          void completion.then(
            () => deferredCleanups.delete(completion),
            () => deferredCleanups.delete(completion),
          )
        },
        eventBus: options.pi.events,
        subagentEventBus: session.subagentEventBus,
        authStorage: session.authStorage,
        modelRegistry: session.modelRegistry,
        settings: session.settings,
        asyncJobManager: session.asyncJobManager,
        skills: [...root.skills],
        extensionRoots: () => root.effectiveExtensionRoots,
        preloadedPreparedExtensions: root.preparedExtensions,
        preloadedCustomToolPaths: [],
        localProtocolOptions: options.ctx.localProtocolOptions,
        parentArtifactManager: root.sessionManager.getArtifactManager() ?? undefined,
        parentHindsightSessionState: root.getHindsightSessionState(),
        parentMnemopiSessionState: root.getMnemopiSessionState(),
        parentAgentId: options.ctx.agent.id,
        parentPromptCacheKey: root.model
          ? (root.getPromptCacheKeyForModel(root.model) ?? providerSessionId)
          : undefined,
        parentServiceTier: session.getServiceTierByFamily?.() ?? null,
      })
    } finally {
      release()
    }
  } finally {
    semaphore.resize(cfgTaskMaxConcurrency.get(root.settings))
    semaphore.release()
  }
}
