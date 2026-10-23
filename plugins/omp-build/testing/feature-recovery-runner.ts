import { createExtensionApiStub } from '../omp/__tests__/extension-api-stub.ts'
import ompBuildExtension, { createOmpFixPort } from '../omp/index.ts'
import type { NativeBatch, NativeBatchResult, NativeChildResult } from '../omp/review-runtime.ts'
import { loadFeatureWorkflow } from '../roxabi/feature-entry.ts'

type Payload = {
  reference: string
  control: 'continue' | 'resume' | 'pause'
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
  const resolvedControl = control === 'continue' || control === 'resume' || control === 'pause' ? control : 'continue'
  return {
    reference: typeof reference === 'string' ? reference : '',
    control: resolvedControl,
    pr: typeof pr === 'number' && Number.isSafeInteger(pr) ? pr : 0,
    code: typeof code === 'number' && Number.isSafeInteger(code) ? code : 1,
  }
}

function incompleteNativeResult(batch: NativeBatch): NativeBatchResult {
  const child: NativeChildResult = {
    id: null,
    expectedId: batch.tasks.tasks[0]?.name ?? null,
    submissions: [],
    proofEvidence: null,
    raw: null,
    partialText: null,
    structured: null,
    usable: false,
    reason: 'missing-native-result',
  }
  return { batch, children: [child], raw: null, complete: false }
}

const [operation, cwd, payloadText] = process.argv.slice(2)
const payload = payloadFrom(JSON.parse(payloadText ?? '{}') as unknown)
const workflow = await loadFeatureWorkflow()

async function continueFeature() {
  return workflow.continueFeature({
    cwd: cwd ?? '',
    reference: payload.reference,
    control: payload.control,
    principal: false,
    native: {
      activate() {
        throw new Error('unexpected-native-activation')
      },
      inactive() {
        throw new Error('unexpected-native-inactivation')
      },
      async stopOwned() {
        throw new Error('unexpected-native-stop')
      },
      async announce() {
        throw new Error('unexpected-native-announcement')
      },
    },
  })
}

async function invoke(operationName: string): Promise<unknown> {
  switch (operationName) {
    case 'continue':
      return continueFeature()
    case 'watch':
      return workflow.consumeWatchExit({
        cwd: cwd ?? '',
        pr: payload.pr,
        code: payload.code,
        reference: payload.reference,
      })
    case 'continuation-publish': {
      const continuation = await continueFeature()
      if (continuation.kind !== 'action') throw new Error(`continuation-not-action:${continuation.kind}`)
      const published = await workflow.publishFeatureNativeResult({
        cwd: cwd ?? '',
        result: incompleteNativeResult(continuation.followUp),
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
    case 'omp-pause':
      return invokeOmpBridge()
    case 'omp-lifetime':
      return invokeOmpLifetime()
    default:
      throw new Error(`unknown operation ${operationName}`)
  }
}

async function invokeOmpBridge(): Promise<{ messages: string[] }> {
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
    isIdle: () => true,
  }

  ompBuildExtension(api, { principalCwd: () => false })
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  for (const handler of events.get('message_end') ?? []) {
    await handler({ message: { role: 'assistant', stopReason: 'aborted', errorId: 67_108_864 } }, context)
  }
  return { messages }
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
    isIdle: () => true,
  }
  ompBuildExtension(api, { principalCwd: () => false })
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  await feature('#42', context)
  const port = createOmpFixPort(api)
  const original = port.active()
  if (original === null) throw new Error('feature-batch-not-active')
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
