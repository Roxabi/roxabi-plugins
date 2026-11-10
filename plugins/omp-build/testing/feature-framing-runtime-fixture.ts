import type { ExtensionContext, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../adapters/github/types.ts'
import { FRAMING_PROCEDURE_FILES } from '../engine/framing-context-schema.ts'
import ompBuildExtension from '../omp/index'
import { FRAMING_SHORTCUT } from '../omp/omp-framing-runtime.ts'
import type * as operatorConfirmation from '../omp/omp-operator-confirmation.ts'
import type { UwOperationsFactory } from '../omp/omp-uw-command.ts'
import type { FeatureWorkflow } from '../roxabi/feature-contract.ts'
import { FRAMING_SUBMIT_TOOL } from '../roxabi/feature-framing-contract.ts'
import type { PinnedFileRef } from '../roxabi/uw-action-contract.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { fixtureUwOperations } from './action-input-fixtures.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { consultableProtocolOptions } from './protocol-retention.unit.ts'
import { UW } from './uw-operations-fixture-input.ts'

export const CWD = '/repo/feature'
const ROOT_AGENT = { kind: 'main' as const, id: 'Main', depth: 0 }
export const CHILD_AGENT = { kind: 'sub' as const, id: 'Child', depth: 1 }

export const confirmationProposal = {
  digest: '4'.repeat(64),
  proposal: {
    format: 'omp-build-material-acceptance/2',
    operationId: 'accept-material-fixture-42',
    uw: UW,
    mandate: { scope: UW, recordId: 'm1', kind: 'mandate' },
    predecessor: {
      scope: UW,
      recordId: 'p1',
      kind: 'operator-control',
    },
    assessment: {
      scope: UW,
      recordId: 'a1',
      kind: 'action-receipt',
    },
    classification: 'material',
    exactInputs: {},
  },
} as unknown as Parameters<operatorConfirmation.CommandOperatorPort['executeConfirmed']>[0]

const BUILTINS = ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'task']
const pin = {
  name: 'omp-build' as const,
  version: '1',
  repository: 'example/plugin',
  commit: 'a'.repeat(40),
  root: 'plugins/omp-build',
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown
/** The registered surface the test drives: provenance, and execute yielding the result text. */
type RegisteredTool = Readonly<{
  name: string
  sourcePath: string | undefined
  execute(toolCallId: string, params: unknown, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<string>
}>
type Session = {
  id: string
  idle: boolean
  aborts: number
  confirms: number
  artifacts: { getArtifactsDir(): string }
}

function procedurePorts() {
  const files = new Map<string, Buffer>(
    Object.values(FRAMING_PROCEDURE_FILES).map((path) => [
      path,
      Buffer.from(`# ${path}\n\n## Steps\n1. Inspect facts.\n\n## Done\nFacts retained.\n`),
    ]),
  )
  return {
    plugin: {
      resolveInstalledPluginPin: async () => ({ ok: true as const, value: pin }),
      readInstalledFile: async (path: string) => {
        const value = files.get(path)
        return value
          ? { ok: true as const, value }
          : { ok: false as const, diagnostics: [{ code: 'missing', message: path }] }
      },
    },
    readPinnedFile: async (ref: PinnedFileRef) => {
      const value = files.get(ref.path.slice(`${pin.root}/`.length))
      return value
        ? { ok: true as const, value }
        : { ok: false as const, diagnostics: [{ code: 'missing', message: ref.path }] }
    },
  }
}

const repositoryGh: Gh = async (_cwd, args) => {
  if (args.join(' ') === 'repo view --json nameWithOwner') return JSON.stringify({ nameWithOwner: 'acme/widgets' })
  throw new Error(`unexpected-gh: ${args.join(' ')}`)
}

const unexpectedGit: GitRunner = async (_cwd, args) => {
  throw new Error(`unexpected-git: ${args.join(' ')}`)
}

export function session(id = 'root-session'): Session {
  return { id, idle: true, aborts: 0, confirms: 0, artifacts: consultableProtocolOptions() }
}

export function contextOf(state: Session, agent: { kind: 'main' | 'sub'; id: string; depth: number } = ROOT_AGENT) {
  const context = {
    cwd: CWD,
    hasUI: true,
    mode: 'tui',
    agent: { ...agent, name: agent.id },
    model: { contextWindow: 128_000 },
    localProtocolOptions: state.artifacts,
    sessionManager: {
      getSessionId: () => state.id,
      getCwd: () => CWD,
      getSessionFile: () => `${CWD}/${state.id}.jsonl`,
      getArtifactsDir: () => state.artifacts.getArtifactsDir(),
      getBranch: () => [],
    },
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    abort: () => {
      state.aborts += 1
    },
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      confirm: async () => {
        state.confirms += 1
        return false
      },
    },
  }
  return context as unknown as ExtensionContext
}

export function toolInfo(name: string, source: string, path: string): ToolInfo {
  return {
    name,
    description: name,
    parameters: {} as ToolInfo['parameters'],
    sourceInfo: { path, source, scope: 'user', origin: 'top-level' },
  }
}

export function workflow(continueFeature: FeatureWorkflow['continueFeature']): FeatureWorkflow {
  return {
    continueFeature,
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'unexpected-watch' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'unexpected-pause' }),
  }
}

/** The installed extension, driven only through what it registers on the public API. */
export function installed(
  options: { featureWorkflow?: FeatureWorkflow; tools?: () => ToolInfo[]; uwOperations?: UwOperationsFactory } = {},
) {
  const listeners = new Map<string, Handler[]>()
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const tools = new Map<string, RegisteredTool>()
  const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>()
  const userMessages: Array<{ content: unknown; options: unknown }> = []
  const messages: string[] = []
  const notification = Promise.withResolvers<void>()
  let procedureReads = 0
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler as unknown as Handler)
      listeners.set(event, list)
    },
    registerCommand: (name, command) => {
      commands.set(name, command.handler as (args: string, ctx: ExtensionContext) => Promise<void>)
    },
    registerTool: (definition) => {
      tools.set(definition.name, {
        name: definition.name,
        sourcePath: definition.sourcePath,
        async execute(toolCallId, params, ctx, signal) {
          const result = await definition.execute(
            toolCallId,
            params as Parameters<typeof definition.execute>[1],
            signal,
            undefined,
            ctx,
          )
          return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
        },
      })
    },
    registerShortcut: (shortcut, shortcutOptions) => {
      shortcuts.set(shortcut, shortcutOptions.handler)
    },
    sendUserMessage: (content, sendOptions) => {
      userMessages.push({ content, options: sendOptions })
      notification.resolve()
    },
    sendMessage: (message) => {
      messages.push(typeof message === 'string' ? message : String(message.content))
      notification.resolve()
    },
    getAllTools: () =>
      options.tools?.() ?? [
        ...BUILTINS.map((name) => toolInfo(name, 'builtin', `<builtin:${name}>`)),
        toolInfo('mcp__files_read', 'mcp', '<mcp:mcp__files_read>'),
        ...[...tools.values()].map((tool) =>
          toolInfo(tool.name, 'extension', tool.sourcePath ?? '/installed/omp-build/omp/index.ts'),
        ),
      ],
  })
  ompBuildExtension(pi, {
    principalCwd: () => false,
    uwOperations: options.uwOperations ?? (() => fixtureUwOperations()),
    ...(options.featureWorkflow === undefined ? {} : { featureWorkflow: options.featureWorkflow }),
    framing: {
      gh: repositoryGh,
      git: unexpectedGit,
      procedurePorts: () => {
        procedureReads += 1
        return procedurePorts()
      },
    },
  })
  function command(args: string, ctx: ExtensionContext, name: 'feature' | 'uw' = 'feature'): Promise<void> {
    const handler = commands.get(name)
    if (handler === undefined) throw new Error(`${name}-command-missing`)
    return handler(args, ctx)
  }
  async function emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
    for (const handler of listeners.get(event) ?? []) {
      const result = await handler(payload, ctx)
      if (result !== undefined) return result
    }
    return undefined
  }
  /** Every registered tool gate, as the SDK runs them: any block wins. */
  async function admits(toolName: string, ctx: ExtensionContext): Promise<boolean> {
    for (const handler of listeners.get('tool_call') ?? []) {
      const result = await handler({ type: 'tool_call', toolCallId: `call-${toolName}`, toolName, input: {} }, ctx)
      if (typeof result === 'object' && result !== null && 'block' in result && result.block === true) return false
    }
    return true
  }
  async function submit(params: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<unknown> {
    const tool = tools.get(FRAMING_SUBMIT_TOOL)
    if (tool === undefined) throw new Error('framing-submit-tool-missing')
    return JSON.parse(await tool.execute('submit-call', params, ctx, signal))
  }
  async function shortcut(ctx: ExtensionContext): Promise<void> {
    const handler = shortcuts.get(FRAMING_SHORTCUT)
    if (handler === undefined) throw new Error('framing-shortcut-missing')
    await handler(ctx)
  }
  return {
    command,
    emit,
    admits,
    submit,
    shortcut,
    userMessages,
    messages,
    notification: notification.promise,
    procedureReads: () => procedureReads,
  }
}
