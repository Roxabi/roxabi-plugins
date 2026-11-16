import ompBuildExtension from '../omp/index.ts'
import { createOmpFixPort } from '../omp/omp-controller.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { provisionNativeRoot } from './native-root-fixture.ts'

type Handler = (...args: unknown[]) => unknown
export async function invokeOmpLifetime(cwd: string): Promise<{
  activeBeforePause: boolean
  cloneRetained: boolean
  activeAfterPause: boolean
  messages: string[]
}> {
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
    cwd: cwd ?? '',
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    sessionManager: { getSessionId: () => 'recovery-lifetime-root' },
    isIdle: () => true,
  }
  provisionNativeRoot(context)
  ompBuildExtension(api, { principalCwd: () => false })
  for (const handler of events.get('session_start') ?? []) await handler({ type: 'session_start' }, context)
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  const port = createOmpFixPort(api)
  const original = port.active()
  if (original === null) throw new Error(`feature-batch-not-active: ${JSON.stringify(messages)}`)
  const activeBeforePause = port.active() === original
  await port.stopOwned(structuredClone(original), 'clone-must-not-stop')
  const cloneRetained = port.active() === original
  for (const handler of events.get('message_end') ?? []) {
    await handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67_108_864 } }, context)
  }
  return {
    activeBeforePause,
    cloneRetained,
    activeAfterPause: port.active() === null,
    messages,
  }
}
