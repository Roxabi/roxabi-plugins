import ompBuildExtension, { type OmpBuildExtensionApi } from '../omp/index.ts'
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
    default:
      throw new Error(`unknown operation ${operationName}`)
  }
}

async function invokeOmpBridge(): Promise<{ messages: string[] }> {
  const commands = new Map<string, Handler>()
  const events = new Map<string, Handler[]>()
  const messages: string[] = []
  const api = {
    on(name: string, handler: Handler) {
      const registered = events.get(name) ?? []
      registered.push(handler)
      events.set(name, registered)
    },
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command.handler)
    },
    registerTool() {},
    sendUserMessage(message: string) {
      messages.push(message)
    },
    sendMessage(message: unknown) {
      if (typeof message === 'string') {
        messages.push(message)
        return
      }
      if (message !== null && typeof message === 'object' && 'content' in message) {
        messages.push(String(message.content))
        return
      }
      messages.push(String(message))
    },
    async exec(): Promise<never> {
      throw new Error('unexpected-omp-exec')
    },
    events: { on: () => () => undefined },
    // OMP's callback overloads cannot retain a heterogeneous event map.
  } as unknown as OmpBuildExtensionApi
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

process.stdout.write(`${JSON.stringify(await invoke(operation ?? ''))}\n`)
