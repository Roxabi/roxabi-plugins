import ompBuildExtension from '../omp/index.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { createConcurrentPausePull, makePauseDisarmUnreadable } from './feature-recovery-pause-fixture.ts'
import { provisionNativeRoot } from './native-root-fixture.ts'

type Handler = (...args: unknown[]) => unknown

export async function invokeOmpBridge(
  cwd: string,
  injectUnconfirmedPause = false,
  interrupt = true,
): Promise<{ messages: string[]; pausePr: number | null }> {
  const commands = new Map<string, Handler>()
  const events = new Map<string, Handler[]>()
  const messages: string[] = []
  const api = createExtensionApiStub({
    on(name, handler) {
      const registered = events.get(name) ?? []
      registered.push(handler as Handler)
      events.set(name, registered)
    },
    registerCommand(name, command) {
      commands.set(name, command.handler as Handler)
    },
    async sendUserMessage(message) {
      if (typeof message !== 'string') throw new Error('native-announcement-not-text')
      messages.push(message)
    },
    sendMessage(message) {
      messages.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
    async exec(): Promise<never> {
      throw new Error('unexpected-omp-exec')
    },
  })
  const context = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    sessionManager: { getSessionId: () => 'recovery-bridge-root' },
    isIdle: () => true,
  }
  provisionNativeRoot(context)
  ompBuildExtension(api, { principalCwd: () => false })
  for (const handler of events.get('session_start') ?? []) await handler({ type: 'session_start' }, context)
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  if (!interrupt) return { messages, pausePr: null }
  const pausePr = injectUnconfirmedPause ? createConcurrentPausePull(cwd) : null
  if (pausePr !== null) makePauseDisarmUnreadable(pausePr)
  for (const handler of events.get('message_end') ?? []) {
    await handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67_108_864 } }, context)
  }
  return { messages, pausePr }
}
