import type { ExtensionContext, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { FRAMING_PROCEDURE_FILES } from '../../engine/framing-context-schema.ts'
import type { ContinueFeatureResult, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { FRAMING_SUBMIT_TOOL } from '../../roxabi/feature-framing-contract.ts'
import type { PinnedFileRef } from '../../roxabi/uw-action-contract.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import ompBuildExtension from '../index'
import { FRAMING_SHORTCUT } from '../omp-framing-runtime.ts'

const CWD = '/repo/feature'
const ROOT_AGENT = { kind: 'main' as const, id: 'Main', depth: 0 }
const CHILD_AGENT = { kind: 'sub' as const, id: 'Child', depth: 1 }
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

function session(id = 'root-session'): Session {
  return { id, idle: true, aborts: 0, confirms: 0, artifacts: consultableProtocolOptions() }
}

function contextOf(state: Session, agent: { kind: 'main' | 'sub'; id: string; depth: number } = ROOT_AGENT) {
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

function toolInfo(name: string, source: string, path: string): ToolInfo {
  return {
    name,
    description: name,
    parameters: {} as ToolInfo['parameters'],
    sourceInfo: { path, source, scope: 'user', origin: 'top-level' },
  }
}

function workflow(continueFeature: FeatureWorkflow['continueFeature']): FeatureWorkflow {
  return {
    continueFeature,
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'unexpected-watch' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'unexpected-pause' }),
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function contextEvent() {
  return { type: 'context', messages: [{ role: 'user', content: 'Frame the billing export', timestamp: 1 }] }
}

/** The installed extension, driven only through what it registers on the public API. */
function installed(options: { featureWorkflow?: FeatureWorkflow; tools?: () => ToolInfo[] } = {}) {
  const listeners = new Map<string, Handler[]>()
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const tools = new Map<string, RegisteredTool>()
  const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>()
  const userMessages: Array<{ content: unknown; options: unknown }> = []
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
          // As the SDK does, execute receives the model's arguments; the submit path validates them itself.
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
    },
    sendMessage: () => undefined,
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
    uwOperations: () => fixtureUwOperations(),
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

  function command(args: string, ctx: ExtensionContext): Promise<void> {
    const handler = commands.get('feature')
    if (handler === undefined) throw new Error('feature-command-missing')
    return handler(args, ctx)
  }
  async function emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown> {
    for (const handler of listeners.get(event) ?? []) {
      const result = await handler(payload, ctx)
      if (result !== undefined) return result
    }
    return undefined
  }
  /** Every registered `tool_call` gate, as the SDK runs them: any block wins. */
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
    procedureReads: () => procedureReads,
  }
}

async function interviewing(host: ReturnType<typeof installed>, root: ExtensionContext, args: string) {
  await host.command(args, root)
  if (host.userMessages.length === 0) throw new Error('framing-interview-not-started')
}

describe('assisted /feature framing in the installed extension', () => {
  it('frames free text in the same turn with the exact command text', async () => {
    const host = installed()
    const root = contextOf(session())
    const args = '  ship  the billing export '

    await host.command(args, root)

    expect(host.userMessages).toEqual([{ content: args, options: { attribution: 'user' } }])
    expect(host.procedureReads()).toBe(1)
  })

  it('admits only built-in read tools and the submit tool while framing, ahead of the missing-contract bypass', async () => {
    const host = installed()
    const root = contextOf(session())
    // No project contract exists at CWD, so outside framing every tool passes the guards.
    expect(await host.admits('bash', root)).toBe(true)

    await interviewing(host, root, 'ship the billing export')

    for (const name of ['read', 'grep', 'glob', FRAMING_SUBMIT_TOOL]) expect(await host.admits(name, root)).toBe(true)
    for (const name of ['bash', 'write', 'edit', 'task', 'mcp__files_read', 'omp_build_start_review', 'unknown_tool'])
      expect(await host.admits(name, root)).toBe(false)
  })

  it('denies same-named tools of another provenance and denies everything when metadata is unreadable', async () => {
    let unreadable = false
    const host = installed({
      tools: () => {
        if (unreadable) throw new Error('tool-metadata-unavailable')
        return [
          toolInfo('read', 'builtin', '<builtin:read>'),
          toolInfo('grep', 'extension', '/elsewhere/grep.ts'),
          toolInfo(FRAMING_SUBMIT_TOOL, 'extension', '/elsewhere/framing-submit.ts'),
        ]
      },
    })
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')

    expect(await host.admits('read', root)).toBe(true)
    expect(await host.admits('grep', root)).toBe(false)
    expect(await host.admits(FRAMING_SUBMIT_TOOL, root)).toBe(false)
    unreadable = true
    expect(await host.admits('read', root)).toBe(false)
  })

  it('projects the framing procedure only into the governed root context', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')
    const event = contextEvent()

    expect(await host.emit('context', event, root)).toMatchObject({
      messages: [event.messages[0], { role: 'custom', display: false }],
    })
    expect(await host.emit('context', contextEvent(), contextOf(state, CHILD_AGENT))).toBeUndefined()
    expect(await host.emit('context', contextEvent(), contextOf(session('other-session')))).toBeUndefined()
  })

  it('refuses a malformed form read-only and keeps the interview', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')

    expect(await host.submit({ form: { kind: 'bogus' } }, root, new AbortController().signal)).toMatchObject({
      status: 'refused',
    })
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
  })

  it('refuses the submit tool outside a governed root framing call', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    const signal = new AbortController().signal

    await expect(host.submit({}, root, signal)).rejects.toThrow()
    await interviewing(host, root, 'ship the billing export')
    await expect(host.submit({}, contextOf(state, CHILD_AGENT), signal)).rejects.toThrow()
    await expect(host.submit({}, root)).rejects.toThrow()
  })

  it('opens no confirmation from the shortcut while nothing is staged', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')

    await host.shortcut(root)

    expect(state.confirms).toBe(0)
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
  })
})

describe('/feature intake before classification', () => {
  it('stays read-only until classified, then settles to an ordinary operation', async () => {
    const classified = deferred<ContinueFeatureResult>()
    const entered = deferred<void>()
    const host = installed({
      featureWorkflow: workflow(async () => {
        entered.resolve()
        return classified.promise
      }),
    })
    const root = contextOf(session())

    const running = host.command('#12', root)
    expect(await host.admits('bash', root)).toBe(false)
    await entered.promise
    expect(await host.admits('bash', root)).toBe(false)
    expect(await host.admits('read', root)).toBe(true)
    classified.resolve({ kind: 'blocked', reason: 'fixture-blocked' })
    await running

    expect(await host.admits('bash', root)).toBe(true)
    expect(host.userMessages).toEqual([])
  })

  it('never begins framing from a replaced command whose classification arrives late', async () => {
    const late = deferred<ContinueFeatureResult>()
    const entered = deferred<void>()
    let calls = 0
    const host = installed({
      featureWorkflow: workflow(async () => {
        calls += 1
        if (calls > 1) return { kind: 'blocked', reason: 'fixture-blocked' }
        entered.resolve()
        return late.promise
      }),
    })
    const root = contextOf(session())

    const replaced = host.command('#12', root)
    await entered.promise
    await host.command('#13', root)
    late.resolve({
      kind: 'framing',
      source: { kind: 'issue', uw: { repository: 'acme/widgets', target: 'acme/widgets#12' } },
    })
    await replaced

    expect(host.procedureReads()).toBe(0)
    expect(host.userMessages).toEqual([])
    expect(await host.admits('bash', root)).toBe(true)
  })
})

describe('framing root lifecycle', () => {
  it('revokes on an aborted root stop and keeps denying until the session settles idle', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')
    state.idle = false
    const aborted = new AbortController()
    aborted.abort()

    await host.emit('session_stop', { type: 'session_stop', signal: aborted.signal }, root)

    expect(state.aborts).toBeGreaterThan(0)
    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.submit({}, root, new AbortController().signal)).toMatchObject({ status: 'refused' })
    expect(await host.admits('bash', root)).toBe(false)
    expect(await host.admits('read', root)).toBe(true)

    state.idle = true
    await host.emit('agent_end', { type: 'agent_end', messages: [] }, root)

    expect(await host.admits('bash', root)).toBe(true)
  })

  it('revokes the exact lease when an ordinary root stop aborts later', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')
    const stop = new AbortController()

    await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
    stop.abort()

    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.admits('bash', root)).toBe(true)
  })

  it('leaves a successor lease untouched when a replaced lease stop aborts', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'first billing subject')
    const stop = new AbortController()
    await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)

    await host.command('second billing subject', root)
    stop.abort()

    expect(host.userMessages.map((message) => message.content)).toEqual([
      'first billing subject',
      'second billing subject',
    ])
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
    expect(await host.admits('bash', root)).toBe(false)
  })

  it('invalidates framing on a switch to another session', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')
    const other = contextOf(session('other-session'))

    await host.emit(
      'session_switch',
      { type: 'session_switch', reason: 'resume', previousSessionFile: `${CWD}/root-session.jsonl` },
      other,
    )

    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.admits('bash', other)).toBe(true)
  })
})
