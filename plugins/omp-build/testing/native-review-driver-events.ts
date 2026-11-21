import { dirname, join } from 'node:path'
import * as hostSdk from '@oh-my-pi/pi-coding-agent'
import { cfgTaskAgentModelOverrides } from '@oh-my-pi/pi-coding-agent/task/settings'

type Handler = (...args: unknown[]) => unknown
export type RootContext = {
  cwd: string
  agent: { kind: 'main'; id: string; name: string; depth: number }
  model: { contextWindow: number }
  models: { resolve(role: string): { id: string; provider: string } }
  isIdle(): boolean
  localProtocolOptions: { getArtifactsDir(): string }
  sessionManager: { getSessionId(): string }
}
function modelRouteDiagnostic(context: unknown): string {
  try {
    const manager = Reflect.get(hostSdk, 'SettingsManager')
    if (!manager || typeof manager.create !== 'function') return 'SDK root SettingsManager unavailable'
    if (typeof context !== 'object' || context === null || !('cwd' in context)) return 'root cwd unavailable'
    const settings = manager.create(context.cwd)
    const overrides = cfgTaskAgentModelOverrides.get(settings)
    return `SDK Settings=${settings.constructor?.name ?? 'unknown'}; rawValue=${typeof settings.rawValue}; overrides=${typeof overrides}; cwd matches fixture=${context.cwd === process.argv[3]}`
  } catch (error) {
    return `SDK settings failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function emit(events: Map<string, Handler[]>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of events.get(name) ?? []) {
    const result = await handler(...args)
    if (typeof result === 'object' && result !== null && 'block' in result && result.block === true) {
      const reason = 'reason' in result ? String(result.reason) : 'no reason provided'
      const detail = name === 'before_subagent_spawn' ? `; ${modelRouteDiagnostic(args[1])}` : ''
      throw new Error(`native-fixture-${name}-refused: ${reason}${detail}`)
    }
  }
}

export function rootContext(cwd: string, contextWindow: number): RootContext {
  return {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow },
    models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
    isIdle: () => true,
    localProtocolOptions: { getArtifactsDir: () => join(dirname(cwd), 'native-review-artifacts') },
    sessionManager: { getSessionId: () => 'native-review-fixture-root' },
  }
}

export function pause(events: Map<string, Handler[]>, context: RootContext): Promise<unknown[]> {
  return Promise.all(
    (events.get('message_end') ?? []).map((handler) =>
      handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67108864 } }, context),
    ),
  )
}
