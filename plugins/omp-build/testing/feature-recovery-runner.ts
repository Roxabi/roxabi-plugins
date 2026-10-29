import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { createConcurrentPausePull, makePauseDisarmUnreadable } from './feature-recovery-pause-fixture.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

await installFixtureSdkSettings(process.argv[3] ?? '')
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { createOmpFixPort } = await import('../omp/omp-controller.ts')
const { loadFeatureWorkflow } = await import('../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
const { createInstalledUwReadPort } = await import('../roxabi/uw-read-port.ts')
const { createExtensionApiStub } = await import('./extension-api-stub.ts')
// Load the SDK registry only after the fixture's SDK settings are installed.
const { provisionNativeRoot } = await import('./native-root-fixture.ts')
const { invokeOmpIncompleteNative } = await import('./feature-recovery-incomplete-native.ts')
const { invokeOmpLiveInterleave } = await import('./feature-recovery-live-interleave.ts')
const { observedIncompleteNativeResult } = await import('./feature-recovery-observed-native.ts')
const { invokeOmpReviewApplyFalsify, invokeOmpReviewLifecycle } = await import('./feature-review-lifecycle.ts')
const { invokeReviewRace } = await import('./feature-review-races.ts')

type Payload = {
  reference: string
  control: 'continue' | 'resume' | 'pause' | 'abandon'
  pr: number
  code: number
}

type Handler = (...args: unknown[]) => unknown

function payloadFrom(raw: unknown): Payload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload-invalid')
  const control = 'control' in raw ? raw.control : undefined
  const reference = 'reference' in raw ? raw.reference : undefined
  const pr = 'pr' in raw ? raw.pr : undefined
  const code = 'code' in raw ? raw.code : undefined
  const resolvedControl =
    control === 'continue' || control === 'resume' || control === 'pause' || control === 'abandon'
      ? control
      : 'continue'
  return {
    reference: typeof reference === 'string' ? reference : '',
    control: resolvedControl,
    pr: typeof pr === 'number' && Number.isSafeInteger(pr) ? pr : 0,
    code: typeof code === 'number' && Number.isSafeInteger(code) ? code : 1,
  }
}

const [operation, cwd, payloadText] = process.argv.slice(2)
const payload = payloadFrom(JSON.parse(payloadText ?? '{}') as unknown)
const workflow = await loadFeatureWorkflow()

async function continueFeature() {
  const sessionCwd = cwd ?? ''
  return workflow.continueFeature({
    cwd: sessionCwd,
    reference: payload.reference,
    control: payload.control,
    principal: false,
    read: createInstalledUwReadPort({ cwd: sessionCwd }),
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: noWriteOperator }),
  })
}

const noWriteOperator: OperatorPort = {
  async executeConfirmed() {
    throw new Error('unexpected-uw-write')
  },
}

async function continueWithCommandUw() {
  const sessionCwd = cwd ?? ''
  return workflow.continueFeature({
    cwd: sessionCwd,
    reference: payload.reference,
    control: payload.control,
    principal: false,
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: noWriteOperator }),
  })
}

async function invokeWorkflowOperation(operationName: string): Promise<unknown | null> {
  switch (operationName) {
    case 'continue':
      return continueFeature()
    case 'cold-publish-uw':
      return continueWithCommandUw()
    case 'watch':
      return workflow.consumeWatchExit({
        cwd: cwd ?? '',
        pr: payload.pr,
        code: payload.code,
        reference: payload.reference,
      })
    case 'continuation-publish': {
      const continuation = await continueFeature()
      if (continuation.kind !== 'action') throw new Error(`continuation-not-action:${JSON.stringify(continuation)}`)
      const result = await observedIncompleteNativeResult(continuation.followUp, cwd ?? '')
      const published = await workflow.publishFeatureNativeResult({
        cwd: cwd ?? '',
        result,
        start: continuation.start,
      })
      return {
        agent: continuation.followUp.tasks.tasks[0]?.agent,
        start: continuation.start,
        operationId: continuation.followUp.operationId,
        published,
      }
    }
    case 'pause': {
      let interrupts = 0
      const result = await workflow.requestFeatureSessionPause({
        cwd: cwd ?? '',
        reason: 'session-stop',
        ...(payload.reference.length === 0 ? {} : { reference: payload.reference }),
        interrupt: async () => {
          interrupts += 1
        },
      })
      return { result, interrupts }
    }
    default:
      return null
  }
}

async function invokeSdkDriver(operationName: string): Promise<unknown> {
  switch (operationName) {
    case 'omp-feature':
      return invokeOmpBridge(false, false)
    case 'omp-pause':
      return invokeOmpBridge()
    case 'omp-unconfirmed-pause':
      return invokeOmpBridge(true)
    case 'omp-lifetime':
      return invokeOmpLifetime()
    case 'omp-incomplete-native':
      return invokeOmpIncompleteNative(cwd ?? '')
    case 'omp-live-interleave':
      return invokeOmpLiveInterleave(cwd ?? '')
    case 'omp-review-lifecycle':
      return invokeOmpReviewLifecycle(
        cwd ?? '',
        payload.control === 'pause' ? 'fresh-pause' : payload.control === 'resume' ? 'publication-pause' : 'fix',
      )
    case 'omp-review-apply-falsify':
      return invokeOmpReviewApplyFalsify(cwd ?? '')
    case 'omp-review-race-latest':
    case 'omp-review-race-pause':
      return invokeReviewRace(cwd ?? '', operationName === 'omp-review-race-latest' ? 'latest' : 'pause')
    default:
      throw new Error(`unknown operation ${operationName}`)
  }
}

async function invoke(operationName: string): Promise<unknown> {
  const workflowResult = await invokeWorkflowOperation(operationName)
  return workflowResult ?? invokeSdkDriver(operationName)
}

async function invokeOmpBridge(
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
    sendUserMessage(message) {
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
  const pausePr = injectUnconfirmedPause ? createConcurrentPausePull(cwd ?? '') : null
  if (pausePr !== null) makePauseDisarmUnreadable(pausePr)
  for (const handler of events.get('message_end') ?? []) {
    await handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67_108_864 } }, context)
  }
  return { messages, pausePr }
}
async function invokeOmpLifetime(): Promise<{
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
    sendUserMessage(message) {
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

process.stdout.write(`${JSON.stringify(await invoke(operation ?? ''))}\n`)
