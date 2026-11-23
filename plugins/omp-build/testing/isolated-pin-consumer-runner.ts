import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionCommandContext, ExtensionContext, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
// The SDK settings must be installed before loading the extension.
await installFixtureSdkSettings(cwd)
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { createExtensionApiStub } = await import('./extension-api-stub.ts')
const { operatorDialogUi } = await import('./operator-dialog-ui.ts')

function freshRoot(sessionId: string) {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>()
  const listeners = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
  const tools: ToolInfo[] = ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'task'].map((name) => ({
    name,
    description: name,
    parameters: {} as ToolInfo['parameters'],
    sourceInfo: { path: `<builtin:${name}>`, source: 'builtin', scope: 'user', origin: 'top-level' },
  }))
  const messages: string[] = []
  const userMessages: unknown[] = []
  const displays: string[] = []
  const terminal = Promise.withResolvers<string>()
  const artifacts = join(cwd, `.fixture-artifacts-${sessionId}`)
  mkdirSync(artifacts, { recursive: true })
  const dialog = operatorDialogUi(
    async () => 'confirm',
    (text) => displays.push(text),
  )
  const context = {
    cwd,
    hasUI: true,
    mode: 'tui',
    agent: { kind: 'main' as const, id: sessionId, name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    localProtocolOptions: { getArtifactsDir: () => artifacts },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getArtifactsDir: () => artifacts,
      getCwd: () => cwd,
      getBranch: () => [],
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    ui: {
      ...dialog,
      setStatus: (key: string, text?: string) => {
        if (
          key === 'omp-build-framing' &&
          text &&
          (text.startsWith('feature-framing blocked:') || text.startsWith('feature-framing: interview started'))
        )
          terminal.resolve(text)
      },
      notify: (message: string) => messages.push(message),
    },
  }
  const ctx = context as unknown as ExtensionCommandContext
  const pi = createExtensionApiStub({
    on(name, handler) {
      const handlers = listeners.get(name) ?? []
      handlers.push(handler as (event: unknown, ctx: ExtensionContext) => unknown)
      listeners.set(name, handlers)
    },
    registerCommand(name, command) {
      commands.set(name, command.handler)
    },
    registerTool(tool) {
      tools.push({
        name: tool.name,
        description: tool.name,
        parameters: {} as ToolInfo['parameters'],
        sourceInfo: {
          path: tool.sourcePath ?? '/installed/omp-build/omp/index.ts',
          source: 'extension',
          scope: 'user',
          origin: 'top-level',
        },
      })
    },
    getAllTools: () => tools,
    sendMessage(message) {
      messages.push(typeof message === 'string' ? message : String(message.content))
    },
    async sendUserMessage(content, options) {
      userMessages.push({ content, options })
    },
  })
  ompBuildExtension(pi)
  return { commands, listeners, ctx, messages, userMessages, displays, terminal: terminal.promise }
}

const args = 'Build a billing export for operators'
const before = freshRoot('baseline-root')
for (const handler of before.listeners.get('session_start') ?? []) await handler({ type: 'session_start' }, before.ctx)
const firstFeature = before.commands.get('feature')
if (!firstFeature) throw new Error('feature-command-missing')
await firstFeature(args, before.ctx)
const beforeStatus = await before.terminal

// A separate extension instance and session model the pilot restart after a failed framing lease.
const after = freshRoot('activation-root')
for (const handler of after.listeners.get('session_start') ?? []) await handler({ type: 'session_start' }, after.ctx)
const activate = after.commands.get('tooling-pin')
if (activate) await activate('activate', after.ctx)
const feature = after.commands.get('feature')
if (!feature) throw new Error('feature-command-missing')
await feature(args, after.ctx)
const afterStatus = await after.terminal
const event = { type: 'context', messages: [{ role: 'user', content: args, timestamp: 1 }] }
let projection: unknown
for (const handler of after.listeners.get('context') ?? []) {
  const result = await handler(event, after.ctx)
  if (result !== undefined) {
    projection = result
    break
  }
}
process.stdout.write(
  `${JSON.stringify({ beforeStatus, beforeUserMessages: before.userMessages, afterStatus, displays: after.displays, userMessages: after.userMessages, projection })}\n`,
)
