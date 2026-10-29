import { AgentRegistry } from '@oh-my-pi/pi-coding-agent/registry/agent-registry'

const fixtureRefs = new WeakSet<object>()
const contextRefs = new WeakMap<object, object>()
const registrations: Array<{ registry: AgentRegistry; id: string; ref: object }> = []

export function cleanupNativeRoots(): void {
  for (const { registry, id, ref } of registrations.splice(0)) registry.unregister(id, ref as never)
}

/** Install the public root presentation used by controller-level integration fixtures. */
export function provisionNativeRoot(context: Record<string, unknown>): void {
  const agent = context.agent as { id: string; kind: string } | undefined
  if (agent?.kind !== 'main') return
  const registry = AgentRegistry.global()
  // Dedicated lease tests may provide their own registry/session boundary.
  const existing = registry.get(agent.id)
  if (existing && (contextRefs.get(context) === existing || !fixtureRefs.has(existing))) return
  const manager = context.sessionManager as Record<string, () => string> | undefined
  if (!manager) return
  const cwd = String(context.cwd)
  manager.getSessionFile ??= () => `${cwd}/fixture-session.jsonl`
  manager.getCwd ??= () => cwd
  context.modelRegistry ??= {}
  let active = ['read', 'task', 'omp_build_execute_native_batch']
  let mounted: string[] = []
  const session = {
    modelRegistry: context.modelRegistry,
    sessionManager: manager,
    agent: { sessionId: `fixture-${agent.id}` },
    isDisposed: false,
    isSessionTransitioning: false,
    getEnabledToolNames: () => [...active, ...mounted],
    getActiveToolNames: () => [...active],
    getMountedXdevToolNames: () => [...mounted],
    hasBuiltInTool: (name: string) => name === 'task',
    runToolRegistryMutation: async <T>(fn: () => Promise<T>) => fn(),
    setActiveToolPresentation: async (enabled: string[], nextMounted: string[]) => {
      mounted = [...nextMounted]
      active = enabled.filter((name) => !mounted.includes(name))
    },
    registerSessionChangeCallback: () => () => undefined,
  }
  const ref = registry.register({
    id: agent.id,
    displayName: agent.id,
    kind: 'main',
    session: session as never,
    sessionFile: manager.getSessionFile(),
  })
  fixtureRefs.add(ref)
  registrations.push({ registry, id: agent.id, ref })
  contextRefs.set(context, ref)
}
