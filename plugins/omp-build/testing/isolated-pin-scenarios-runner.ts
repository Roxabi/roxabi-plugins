import { execFileSync } from 'node:child_process'
import { type FSWatcher, mkdirSync, readdirSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionCommandContext, ExtensionContext, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const [cwd, scenario, linked, other] = process.argv.slice(2) as [string, string, string, string]
await installFixtureSdkSettings(cwd)
// SDK settings must exist before loading the installed extension.
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { createExtensionApiStub } = await import('./extension-api-stub.ts')
const { operatorDialogUi } = await import('./operator-dialog-ui.ts')

const controls = process.env.PIN_CONTROL_FILE
if (!controls) throw new Error('fixture-pin-control-missing')
const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>()
const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>()
const statuses: string[] = []
const notices: string[] = []
const messages: unknown[] = []
const displayed: string[] = []
const terminal = Promise.withResolvers<string>()
let currentCwd = cwd
let session = 'pin-session'
const artifacts = join(cwd, '.scenario-artifacts')
mkdirSync(artifacts, { recursive: true })
const context = {
  cwd,
  hasUI: scenario !== 'headless',
  mode: scenario === 'headless' ? 'rpc' : 'tui',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  localProtocolOptions: { getArtifactsDir: () => artifacts },
  sessionManager: {
    getSessionId: () => session,
    getSessionFile: () => undefined,
    getArtifactsDir: () => artifacts,
    getCwd: () => currentCwd,
    getBranch: () => [],
  },
  isIdle: () => true,
  hasPendingMessages: () => false,
  abort: () => undefined,
  ui: {
    ...operatorDialogUi(
      async () => {
        if (scenario === 'stale-candidate') writeFileSync(controls, JSON.stringify({ candidate: 'f'.repeat(40) }))
        if (scenario === 'pending-switch') {
          for (const fn of handlers.get('session_switch') ?? []) await fn({}, ctx)
        }
        if (scenario === 'pending-reload') ompBuildExtension(api)
        return scenario === 'decline' ? 'refuse' : scenario === 'escape' ? 'defer' : 'confirm'
      },
      (text) => displayed.push(text),
    ),
    setStatus(key: string, text?: string) {
      if (key === 'omp-build-framing' && text) {
        statuses.push(text)
        if (text.startsWith('feature-framing blocked:') || text.startsWith('feature-framing: interview started'))
          terminal.resolve(text)
      }
    },
    notify(message: string) {
      notices.push(message)
    },
  },
}
const ctx = context as unknown as ExtensionCommandContext
const tools: ToolInfo[] = ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'task'].map((name) => ({
  name,
  description: name,
  parameters: {} as ToolInfo['parameters'],
  sourceInfo: { path: `<builtin:${name}>`, source: 'builtin', scope: 'user', origin: 'top-level' },
}))
const api = createExtensionApiStub({
  on(name, handler) {
    const found = handlers.get(name) ?? []
    found.push(handler as (event: unknown, ctx: ExtensionContext) => unknown)
    handlers.set(name, found)
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
    notices.push(typeof message === 'string' ? message : String(message.content))
  },
  async sendUserMessage(content) {
    messages.push(content)
  },
})
ompBuildExtension(api)
for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx)
const activate = commands.get('tooling-pin')
if (!activate) throw new Error('fixture-tooling-pin-command-missing')
if (scenario === 'owner-initial' || scenario === 'owner-final') {
  const feature = commands.get('feature')
  if (!feature) throw new Error('fixture-feature-command-missing')
  const gateDir = join(cwd, '.feature-gate')
  mkdirSync(gateDir)
  execFileSync('mkfifo', [join(gateDir, 'release')])
  const featureStarted = Promise.withResolvers<void>()
  const gateWatch = watch(gateDir, (_event, file) => {
    if (file === 'ready') featureStarted.resolve()
  })
  const holdFeature = () => {
    process.env.PIN_FEATURE_GATE = gateDir
    return feature('Build a billing export for operators', ctx)
  }
  let pending: Promise<void> | undefined
  if (scenario === 'owner-initial') {
    // Start without awaiting: the real intake owns the slot before its first asynchronous read.
    pending = holdFeature()
    await featureStarted.promise
    gateWatch.close()
    delete process.env.PIN_FEATURE_GATE
    await activate('activate', ctx)
  } else {
    const syncDir = join(cwd, '.validation-sync')
    mkdirSync(syncDir)
    execFileSync('mkfifo', [join(syncDir, 'release')])
    process.env.PIN_SYNC_DIR = syncDir
    let entered = false
    const validation = watch(syncDir, (_event, file) => {
      if (file !== 'ready' || entered) return
      entered = true
      void (async () => {
        // Re-observation passed its initial ownership check before this external read began.
        pending = holdFeature()
        await featureStarted.promise
        gateWatch.close()
        delete process.env.PIN_FEATURE_GATE
        writeFileSync(join(syncDir, 'release'), 'continue')
      })()
    })
    await activate('activate', ctx)
    validation.close()
  }
  await activate('status', ctx)
  writeFileSync(join(gateDir, 'release'), 'continue')
  await pending
  const outcome = await terminal.promise
  process.stdout.write(`${JSON.stringify({ outcome, notices, displayed, messages })}\n`)
  process.exit(0)
}
let validationWatch: FSWatcher | undefined
if (scenario === 'session-switch-during-validation') {
  const syncDir = join(cwd, '.validation-sync')
  mkdirSync(syncDir)
  execFileSync('mkfifo', [join(syncDir, 'release')])
  process.env.PIN_SYNC_DIR = syncDir
  let released = false
  validationWatch = watch(syncDir, (_event, file) => {
    if (file !== 'ready' || released) return
    released = true
    void (async () => {
      for (const fn of handlers.get('session_switch') ?? []) await fn({}, ctx)
      writeFileSync(join(syncDir, 'release'), 'continue')
    })()
  })
}
if (scenario === 'shared-unavailable') writeFileSync(controls, JSON.stringify({ shared: 'not-a-sha' }))
if (scenario === 'shared-matches') writeFileSync(controls, JSON.stringify({ shared: process.env.PIN_CANDIDATE }))
if (scenario === 'unreachable') writeFileSync(controls, JSON.stringify({ comparison: 'diverged' }))
if (scenario === 'source-repository') {
  writeFileSync(controls, JSON.stringify({ target: 'Roxabi/roxabi-plugins' }))
  execFileSync('git', ['config', 'remote.origin.url', 'https://github.com/Roxabi/roxabi-plugins.git'], { cwd })
}
const originScenarios: Record<string, string> = {
  'credential-origin': 'https://fixture-token@github.com/acme/app.git',
  'lookalike-origin': 'https://notgithub.com/acme/app.git',
  'case-variant-origin': 'https://github.com/ACME/App.git',
}
const remote = originScenarios[scenario]
if (remote) execFileSync('git', ['config', 'remote.origin.url', remote], { cwd })
const artifactsBeforeActivation = readdirSync(artifacts)
const child = {
  ...context,
  agent: { kind: 'sub', id: 'child', name: 'child', depth: 1 },
} as unknown as ExtensionCommandContext
await activate('activate', scenario === 'child' ? child : ctx)
const artifactsAfterActivation = readdirSync(artifacts)
if (scenario === 'credential-origin' || scenario === 'lookalike-origin')
  execFileSync('git', ['config', 'remote.origin.url', 'https://github.com/acme/app.git'], { cwd })
validationWatch?.close()
if (scenario === 'stale-candidate') writeFileSync(controls, '{}')
if (scenario === 'shared-unavailable') writeFileSync(controls, '{}')
if (scenario === 'shared-matches') writeFileSync(controls, '{}')
if (scenario === 'unreachable' || scenario === 'source-repository') writeFileSync(controls, '{}')
if (scenario === 'source-repository')
  execFileSync('git', ['config', 'remote.origin.url', 'https://github.com/acme/app.git'], { cwd })
if (scenario === 'child-factory') {
  ompBuildExtension(createExtensionApiStub())
  await activate('status', child)
}
if (scenario === 'linked') {
  currentCwd = linked
  context.cwd = linked
}
if (scenario === 'other-clone') {
  currentCwd = other
  context.cwd = other
}
if (scenario === 'remote-changed')
  execFileSync('git', ['config', 'remote.origin.url', 'https://github.com/acme/other.git'], { cwd })
if (scenario === 'target-changed') writeFileSync(controls, JSON.stringify({ target: 'acme/other' }))
if (scenario === 'session-switch') {
  session = 'other-session'
  for (const fn of handlers.get('session_switch') ?? []) await fn({}, ctx)
  session = 'pin-session'
}
if (scenario === 'other-session') session = 'other-session'
if (scenario === 'reload') ompBuildExtension(api)
if (scenario === 'other-instance') {
  const secondCommands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>()
  const secondApi = createExtensionApiStub({
    registerCommand(name, command) {
      secondCommands.set(name, command.handler)
    },
    getAllTools: () => tools,
  })
  ompBuildExtension(secondApi)
  const secondFeature = secondCommands.get('feature')
  if (!secondFeature) throw new Error('fixture-second-feature-command-missing')
  commands.set('feature', secondFeature)
}
// The feature uses root TUI even when activation was attempted headlessly.
context.hasUI = true
context.mode = 'tui'
const feature = commands.get('feature')
if (!feature) throw new Error('fixture-feature-command-missing')
await feature('Build a billing export for operators', ctx)
const outcome = await terminal.promise
process.stdout.write(
  `${JSON.stringify({ outcome, notices, displayed, messages, artifactsBeforeActivation, artifactsAfterActivation })}\n`,
)
