import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  fixtureScopeFromReference,
  prepareFictionalNoneIdentifiedHandoffEffects,
} from './context-effect-review-fixture.ts'
import { assessmentConstraints } from './feature-assessment-constraints.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'
import { operatorDialogUi } from './operator-dialog-ui.ts'

const [cwd = '', actionFile = '', reference = '#42', handoff = '', effectsFileArg = ''] = process.argv.slice(2)
await installFixtureSdkSettings(cwd)
// SDK-dependent modules must load after installing this subprocess's fixture settings.
const { default: ompBuildExtension } = await import('../omp/index.ts')
const { reviewControllerFor } = await import('../omp/omp-controller.ts')
const { createExtensionApiStub, fixtureEventBus } = await import('./extension-api-stub.ts')
const { nativeReviewChild } = await import('./native-review-child.ts')
const { provisionNativeRoot } = await import('./native-root-fixture.ts')

type Handler = (...args: unknown[]) => unknown
const commands = new Map<string, Handler>()
const events = new Map<string, Handler[]>()
const messages: string[] = []
let coverageEdits = 0
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
const artifacts = mkdtempSync(join(tmpdir(), 'context-assessment-'))
const context = {
  cwd,
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  hasUI: true,
  mode: 'tui' as const,
  ui: {
    ...operatorDialogUi(async () => 'confirm'),
    async editor(_title: string, text: string) {
      const draft = JSON.parse(text) as {
        context: {
          parent: { uw: { target: string }; version: string }
          criteria: { id: string }[]
          children: { scope: { repository: string; target: string } }[]
        }
        coverage: unknown
      }
      if (
        draft.context.parent.uw.target.split('#').at(-1) !== reference.split('#').at(-1) ||
        draft.context.children.length === 0
      )
        throw new Error('Unexpected parent coverage request')
      draft.coverage = {
        parent: draft.context.parent,
        assignments: draft.context.criteria.map((criterion) => ({
          criterion: criterion.id,
          children: draft.context.children.map((child) => child.scope),
        })),
      }
      coverageEdits++
      return JSON.stringify(draft)
    },
    async confirm() {
      return true
    },
  },
  model: { contextWindow: 128_000 },
  models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
  sessionManager: { getSessionId: () => 'context-assessment-root' },
  isIdle: () => true,
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
  ompBuildExtension(api, { principalCwd: () => false })
  await emit('session_start', { type: 'session_start' }, context)
  const feature = commands.get('feature')
  if (feature === undefined) throw new Error('feature-command-unregistered')
  let featureArgs: string
  if (handoff) {
    const effectsFile =
      effectsFileArg.length > 0
        ? (() => {
            if (!isAbsolute(effectsFileArg)) throw new Error('context-effect-intent-path-must-be-absolute')
            return effectsFileArg
          })()
        : (
            await prepareFictionalNoneIdentifiedHandoffEffects({
              cwd,
              scope: fixtureScopeFromReference(reference),
              negativeRecordId: handoff,
              directory: artifacts,
            })
          ).effectsFile
    featureArgs = `new ${reference} --context-handoff ${handoff} --context-effects ${effectsFile}`
  } else if (actionFile) {
    featureArgs = `${reference} --action ${actionFile}`
  } else {
    featureArgs = reference
  }
  await feature(featureArgs, context)
  const controller = reviewControllerFor(api)
  const active = controller.active()
  if (active === null) {
    process.stdout.write(`${JSON.stringify({ messages, admitted: false, coverageEdits })}\n`)
  } else {
    const task = active.tasks.tasks[0]
    if (!task || active.tasks.tasks.length !== 1 || controller.wire(active) === null)
      throw new Error('assessment-batch-unwired')
    const operands = task.action.inputs.manifest.operands
    if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'native-current')
      throw new Error('assessment-operands-missing')
    const admitted = controller.admit(active, active.operationId, context as never, () => true)
    if (!admitted || !controller.bindChild(task.name, 0, context.models.resolve()))
      throw new Error('native-admission-refused')
    const sessionFile = join(artifacts, 'child.jsonl')
    await emit('task:subagent:lifecycle', {
      status: 'started',
      id: task.name,
      agent: task.agent,
      index: 0,
      parentToolCallId: active.operationId,
      sessionFile,
      detached: false,
    })
    const child = await nativeReviewChild({ task, sessionFile })
    const exact = operands.exactInputs
    const unique = assessmentConstraints(exact)
    if (!unique[0]) throw new Error('assessment-constraints-missing')
    const output = actionFile
      ? {
          classification: 'material',
          compatibility: {
            state: 'consistent',
            examined: unique,
            references: [],
            reason: 'The clarified criterion remains compatible with the original criterion.',
          },
        }
      : {
          outcome: 'missing-context',
          missing: [
            {
              locator: { kind: 'information-request', description: 'Timezone policy' },
              reason: 'The impact cannot be assessed without the policy',
              targets: [],
            },
          ],
        }
    await child.call('yield', 'assessment-yield', { data: output })
    await child.result('yield', 'assessment-yield', { data: output }, { content: [], details: {}, isError: false })
    const observation = {
      toolCallId: active.operationId,
      errors: [],
      results: [
        {
          index: 0,
          id: task.name,
          agent: task.agent,
          exitCode: 0,
          structuredOutput: { status: 'valid', data: output },
        },
      ],
    }
    controller.prepareOwnedResult(observation, context as never)
    controller.queueOwnedSettlement(observation)
    controller.finishExecution(active)
    await controller.ownedSettlement()
    process.stdout.write(
      `${JSON.stringify({ messages, admitted, activeAfterSettlement: controller.active() !== null, coverageEdits })}\n`,
    )
  }
} finally {
  rmSync(artifacts, { recursive: true, force: true })
}
