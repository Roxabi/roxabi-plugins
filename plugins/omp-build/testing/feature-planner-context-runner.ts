import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const [cwd = '', mode = '', actionFile = ''] = process.argv.slice(2)
// The installed SDK registry must load only after fixture settings are installed.
await installFixtureSdkSettings(cwd)
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { reviewControllerFor } = await import('../omp/omp-controller.ts')
const { createExtensionApiStub, fixtureEventBus } = await import('./extension-api-stub.ts')
const { nativeReviewChild } = await import('./native-review-child.ts')
const { provisionNativeRoot } = await import('./native-root-fixture.ts')
type Handler = (...args: unknown[]) => unknown
const commands = new Map<string, Handler>()
const events = new Map<string, Handler[]>()
const messages: string[] = []
const api = createExtensionApiStub({
  events: fixtureEventBus((name, handler) => {
    events.set(name, [...(events.get(name) ?? []), handler as Handler])
    return () => undefined
  }),
  on(name, handler) {
    events.set(name, [...(events.get(name) ?? []), handler as Handler])
  },
  registerCommand(name, command) {
    commands.set(name, command.handler as Handler)
  },
  async sendUserMessage(message) {
    messages.push(String(message))
  },
  sendMessage(message) {
    messages.push(typeof message === 'string' ? message : String(message?.content ?? message))
  },
  async exec(): Promise<never> {
    throw new Error('unexpected-omp-exec')
  },
})
const artifacts = mkdtempSync(join(tmpdir(), 'planner-context-native-'))
let rootIdle = true
const context = {
  cwd,
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
  sessionManager: { getSessionId: () => 'planner-context-root' },
  isIdle: () => rootIdle,
  localProtocolOptions: { getArtifactsDir: () => artifacts },
}
provisionNativeRoot(context)
const emit = async (name: string, ...args: unknown[]) => {
  for (const handler of events.get(name) ?? []) {
    const result = await handler(...args)
    if (typeof result === 'object' && result !== null && 'block' in result && result.block === true)
      throw new Error(`${name} refused`)
  }
}
try {
  if (mode === 'positive-both') {
    const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
    const { continueFeature } = await import('../roxabi/workflow.ts')
    const { finishContextPlan } = await import('./feature-context-plan-driver.ts')
    const operator = {
      async executeConfirmed(): Promise<never> {
        throw new Error('unexpected-uw-write')
      },
    }
    const uw = await createInstalledUwOperations({ cwd, operator })
    const selected = await continueFeature({ cwd, reference: '#42', control: 'continue', principal: false, uw })
    const result = await finishContextPlan(cwd, operator, selected)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    ompBuildExtension(api, { principalCwd: () => false })
    await emit('session_start', { type: 'session_start' }, context)
    const feature = commands.get('feature')
    if (!feature) throw new Error('feature-command-unregistered')
    if (actionFile) {
      const uw = commands.get('uw')
      if (!uw) throw new Error('uw-command-unregistered')
      await uw(`action ${actionFile}`, context)
      if (reviewControllerFor(api).active() !== null) throw new Error('preparation-dispatched-native-work')
    }
    await feature(actionFile ? `#42 --action ${actionFile}` : '#42', context)
    const controller = reviewControllerFor(api)
    const active = controller.active()
    if (active === null) {
      const detail = messages
        .map((message) => message.match(/detail=([^ ]+)/)?.[1])
        .filter((file): file is string => file !== undefined)
        .map((file) => {
          try {
            return JSON.parse(readFileSync(file, 'utf8'))
          } catch {
            return null
          }
        })
      process.stdout.write(`${JSON.stringify({ admitted: false, messages, detail })}\n`)
    } else {
      const settle = async (active: NativeBatch, negative: boolean, round: number) => {
        rootIdle = false
        await emit('agent_start', { type: 'agent_start' }, context)
        if (
          controller.wire(active) === null ||
          !controller.admit(active, active.operationId, context as never, () => true)
        )
          throw new Error('native-admission-refused')
        const selected = active.tasks.tasks.map((_, i) => i)
        const results = []
        for (const index of selected) {
          const task = active.tasks.tasks[index]
          if (!task || !controller.bindChild(task.name, index, context.models.resolve()))
            throw new Error('native-child-unbound')
          const sessionFile = join(artifacts, `child-${round}-${index}.jsonl`)
          await emit('task:subagent:lifecycle', {
            status: 'started',
            id: task.name,
            agent: task.agent,
            index,
            parentToolCallId: active.operationId,
            sessionFile,
            detached: false,
          })
          const child = await nativeReviewChild({ task, sessionFile })
          const output =
            negative && (selected.length === 1 || index === 1)
              ? {
                  outcome: 'missing-context',
                  missing: [
                    {
                      locator: { kind: 'information-request', description: 'Deployment region' },
                      reason: 'Not in the supplied context',
                      targets: [],
                    },
                  ],
                }
              : task.agent === 'R-workflow-plan'
                ? {
                    steps: [
                      {
                        id: 'preserve-region',
                        criterionIds: ['C1'],
                        change: 'Preserve the region',
                        doneWhen: 'Region is saved',
                        evidence: 'Check the saved region',
                        paths: ['README.md'],
                      },
                    ],
                    resolutions: [],
                  }
                : { outcome: 'clear', blockers: [] }
          const call = `planner-yield-${round}-${index}`
          await child.call('yield', call, { data: output })
          await child.result('yield', call, { data: output }, { content: [], details: {}, isError: false })
          results.push({
            index,
            id: task.name,
            agent: task.agent,
            exitCode: 0,
            structuredOutput: { status: 'valid' as const, data: output },
          })
        }
        const observation = { toolCallId: active.operationId, errors: [], results }
        controller.prepareOwnedResult(observation, context as never)
        controller.queueOwnedSettlement(observation)
        controller.finishExecution(active)
        await controller.settlementFor(active)
        rootIdle = true
        await emit('agent_end', { type: 'agent_end', willContinue: false }, context)
      }
      if (mode === 'positive-then-negative') {
        await settle(active, false, 0)
        const review = controller.active()
        if (review === null || review.tasks.tasks.length !== 2)
          throw new Error(`native-plan-review-not-dispatched: ${JSON.stringify(messages)}`)
        await settle(review, true, 1)
      } else {
        await settle(active, mode === 'negative', 0)
      }
      process.stdout.write(
        `${JSON.stringify({ admitted: true, operationId: active.operationId, tasks: active.tasks.tasks.map((task) => task.name), messages })}\n`,
      )
    }
  }
} finally {
  rmSync(artifacts, { recursive: true, force: true })
}
