import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionCommandContext, ExtensionContext, SessionEntry, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
await installFixtureSdkSettings(cwd)
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { createExtensionApiStub } = await import('./extension-api-stub.ts')
const { operatorDialogUi } = await import('./operator-dialog-ui.ts')
const { uwMember } = await import('./framing-runtime-fixture.ts')

const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>()
const shortcuts = new Map<string, () => Promise<void>>()
const entries: SessionEntry[] = []
const statuses: string[] = []
const widgets = new Map<string, string[]>()
const notices: string[] = []
const displayed: string[] = []
const tools: ToolInfo[] = ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'task'].map((name) => ({
  name,
  description: name,
  parameters: {} as ToolInfo['parameters'],
  sourceInfo: { path: `<builtin:${name}>`, source: 'builtin', scope: 'user', origin: 'top-level' },
}))
let currentCwd = cwd
const artifacts = join(cwd, '.framing-artifacts')
mkdirSync(artifacts, { recursive: true })
const started = Promise.withResolvers<void>()
const composed = Promise.withResolvers<void>()
const deliveries: string[] = []
const failure = Promise.withResolvers<void>()
const context = {
  cwd,
  hasUI: true,
  mode: 'tui',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  localProtocolOptions: { getArtifactsDir: () => artifacts },
  sessionManager: {
    getSessionId: () => 'framing-pin-session',
    getSessionFile: () => undefined,
    getArtifactsDir: () => artifacts,
    getCwd: () => currentCwd,
    getBranch: () => entries,
  },
  isIdle: () => true,
  hasPendingMessages: () => false,
  abort: () => undefined,
  ui: {
    ...operatorDialogUi(
      async () => 'confirm',
      (text) => displayed.push(text),
    ),
    confirm: async () => true,
    setStatus(key: string, text?: string) {
      if (text) statuses.push(`${key}: ${text}`)
      if (key === 'omp-build-framing' && text?.startsWith('feature-framing: interview started')) started.resolve()
      if (key === 'omp-build-framing' && text?.startsWith('feature-framing blocked:')) failure.resolve()
    },
    setWidget(key: string, lines?: string[]) {
      if (lines) widgets.set(key, lines)
      else widgets.delete(key)
    },
    notify(message: string) {
      notices.push(message)
    },
  },
}
const ctx = context as unknown as ExtensionCommandContext
let submit: ((form: unknown) => Promise<unknown>) | undefined
const api = createExtensionApiStub({
  on(name, handler) {
    const found = handlers.get(name) ?? []
    found.push(handler as (event: unknown, ctx: ExtensionContext) => unknown)
    handlers.set(name, found)
  },
  registerCommand(name, command) {
    commands.set(name, command.handler)
  },
  registerShortcut(name, options) {
    shortcuts.set(name, async () => {
      await options.handler(ctx)
    })
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
    if (tool.name === 'omp_build_framing_submit') {
      submit = async (params) => {
        const result = await tool.execute(
          'submit-call',
          params as Parameters<typeof tool.execute>[1],
          new AbortController().signal,
          undefined,
          ctx,
        )
        return JSON.parse(result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''))
      }
    }
  },
  getAllTools: () => tools,
  sendMessage(message) {
    const text = typeof message === 'string' ? message : String(message.content)
    notices.push(text)
    if (text.startsWith('feature-stopped:')) failure.resolve()
  },
  async sendUserMessage(message) {
    if (typeof message !== 'string') return
    deliveries.push(message)
    if (message.includes('## Feature context')) composed.resolve()
  },
})
ompBuildExtension(api)
for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx)
const pin = commands.get('tooling-pin')
const feature = commands.get('feature')
if (!pin || !feature || !submit) throw new Error('framing-public-surface-missing')
await pin('activate', ctx)
await feature('Build a billing export for operators', ctx)
await started.promise
const submitForm = async (form: unknown) => {
  let projection: unknown
  for (const handler of handlers.get('context') ?? []) {
    projection = await handler({ type: 'context', messages: [] }, ctx)
    if (projection !== undefined) break
  }
  const projected = projection as { messages?: Array<{ content?: unknown }> } | undefined
  const match = /^Supply token: (\S+)$/m.exec(String(projected?.messages?.at(-1)?.content ?? ''))
  if (!match?.[1]) throw new Error(`fixture-supply-missing: ${JSON.stringify({ statuses, notices })}`)
  if (!submit) throw new Error('framing-submit-tool-missing')
  const result = (await submit({ supplyToken: match[1], form })) as { status: string; diagnostics?: unknown[] }
  if (result.status !== 'accepted' && result.status !== 'waiting')
    throw new Error(`fixture-submit-refused: ${JSON.stringify(result)}`)
  return result
}
await submitForm({ kind: 'question', question: 'What should this export do?' })
entries.push(
  {
    type: 'message',
    id: 'q-grill',
    parentId: null,
    timestamp: '2026-10-27T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'submit-call', name: 'omp_build_framing_submit', arguments: {} }],
      timestamp: 1,
    },
  } as unknown as SessionEntry,
  {
    type: 'message',
    id: 'u-grill',
    parentId: null,
    timestamp: '2026-10-27T12:00:00.000Z',
    message: {
      role: 'user',
      content: 'Export billing data for operators',
      timestamp: 1,
    },
  } as SessionEntry,
)
await submitForm({
  kind: 'grilling',
  shape: 'leaf',
  unresolved: [],
  decisions: [{ questionEntryId: 'q-grill', answerEntryId: 'u-grill', decision: 'Export billing data for operators' }],
  terms: [],
})
const member = uwMember(
  { kind: 'new', key: 'root', repository: 'acme/app' },
  'Billing export',
  'export',
  'Operators can export billing data',
)
await submitForm({
  kind: 'proposal',
  decisions: [],
  modules: [],
  vocabulary: [],
  aggregate: {
    kind: 'uw',
    root: 'root',
    members: [{ ...member, slot: { kind: 'new', key: 'root' } }],
    edges: [],
    coverage: [],
    foundations: [],
  },
})
const shortcut = shortcuts.get('ctrl+alt+u')
if (!shortcut) throw new Error('framing-shortcut-missing')
await shortcut()
const framingWidget = widgets.get('omp-build-framing')
const move = framingWidget?.find((line) => line.startsWith('/move '))
if (!move || !framingWidget?.some((line) => line.includes('Ctrl+Alt+U')))
  throw new Error(`fixture-handoff-missing: ${JSON.stringify({ framingWidget, statuses, notices })}`)
currentCwd = move.slice('/move '.length)
context.cwd = currentCwd
await shortcut()
if (widgets.has('omp-build-framing')) throw new Error('fixture-handoff-move-prompt-not-cleared')
const timedOut = Promise.withResolvers<void>()
const timer = setTimeout(timedOut.resolve, 10_000)
const delivery = await Promise.race([
  composed.promise.then(() => 'composition'),
  failure.promise.then(() => 'failure'),
  timedOut.promise.then(() => 'timeout'),
])
clearTimeout(timer)
if (delivery !== 'composition')
  throw new Error(
    `fixture-handoff-${delivery}: ${JSON.stringify({ statuses, notices, displayed, destination: currentCwd })}`,
  )
process.stdout.write(`${JSON.stringify({ statuses, notices, displayed, deliveries, destination: currentCwd })}\n`)
process.exit(0)
