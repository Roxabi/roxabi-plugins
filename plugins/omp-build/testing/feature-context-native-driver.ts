import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ompBuildExtension from '../omp/index.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'
import { createExtensionApiStub, fixtureEventBus } from './extension-api-stub.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { nativeReviewChild } from './native-review-child.ts'
import { provisionNativeRoot } from './native-root-fixture.ts'

type Handler = (...args: unknown[]) => unknown
export async function invokeContextNative(cwd: string, actionFile: string, positive: boolean, initial = false) {
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
  const artifacts = mkdtempSync(join(tmpdir(), 'context-native-'))
  const context = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
    sessionManager: { getSessionId: () => 'context-native-root' },
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
    let preparation: string[] = []
    if (!initial) {
      const uw = commands.get('uw')
      if (uw === undefined) throw new Error('uw-command-unregistered')
      const before = messages.length
      await uw(`action ${actionFile}`, context)
      preparation = messages.slice(before)
      if (reviewControllerFor(api).active() !== null) throw new Error('preparation-dispatched-native-work')
    }
    await feature(initial ? '#42' : `#42 --action ${actionFile}`, context)
    const controller = reviewControllerFor(api)
    const active = controller.active()
    if (active === null) return { messages, preparation, operationId: null, admitted: false }
    const task = active.tasks.tasks[0]
    if (task === undefined || controller.wire(active) === null) throw new Error('feature-batch-unwired')
    const admitted = controller.admit(active, active.operationId, context as never, () => true)
    if (!admitted || !controller.bindChild(task.name, 0, context.models.resolve()))
      throw new Error('native-admission-refused')
    const sessionFile = join(artifacts, 'child-0.jsonl')
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
    let output: object = {
      outcome: 'missing-context',
      missing: [
        {
          locator: { kind: 'information-request', description: 'deployment region confirmation' },
          reason: 'confirmation is required',
          targets: [],
        },
      ],
    }
    if (initial)
      output = {
        outcome: 'blocked',
        commitSHAs: [],
        commands: [],
        criteria: [],
        missing: [
          {
            locator: { kind: 'information-request', description: 'deployment region confirmation' },
            reason: 'confirmation is required',
            targets: [],
          },
        ],
        reason: 'The region is required before implementation',
      }
    async function positiveOutput() {
      writeFileSync(join(cwd, 'README.md'), initial ? 'region preserved\ntimezone preserved\n' : 'region preserved\n')
      execFileSync('git', ['add', '--', 'README.md'], { cwd })
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-qm',
          'feat: preserve region (#42)',
        ],
        { cwd },
      )
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
      const command = initial
        ? "grep -qx 'region preserved' README.md && grep -qx 'timezone preserved' README.md"
        : "grep -qx 'region preserved' README.md"
      const toolCallId = 'context-recovery-proof'
      await child.call('bash', toolCallId, { command })
      execFileSync('grep', ['-qx', 'region preserved', 'README.md'], { cwd })
      if (initial) execFileSync('grep', ['-qx', 'timezone preserved', 'README.md'], { cwd })
      await child.result('bash', toolCallId, { command }, { content: [], details: { exitCode: 0 }, isError: false })
      const spec = task.action.inputs.manifest.spec
      if (spec.kind !== 'accepted') throw new Error('Accepted implementation Spec unavailable')
      const target = { format: 'omp-build-finding-target/1', kind: 'criterion', spec: spec.effective.own, id: 'C1' }
      return {
        outcome: 'implemented',
        commitSHAs: [head],
        commands: [{ toolCallId, command, exitCode: 0 }],
        criteria: [
          {
            target,
            verification: 'evidence',
            evidence: [
              {
                id: 'context-recovery-criterion',
                target,
                method: 'test',
                scenario: initial ? 'preserves the region and timezone' : 'preserves the region',
                before: null,
                after: {
                  toolCallId,
                  versionClaim: {
                    code: { repository: SCOPE.repository, commit: head },
                    reason: 'Observed at test execution',
                    references: [],
                  },
                },
              },
            ],
          },
        ],
        reason: 'Captured test completed after implementation',
      }
    }
    if (positive) output = await positiveOutput()
    await child.call('yield', 'context-yield', { data: output })
    await child.result('yield', 'context-yield', { data: output }, { content: [], details: {}, isError: false })
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
    return {
      messages,
      preparation,
      operationId: active.operationId,
      admitted,
      activeAfterSettlement: controller.active() !== null,
    }
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
}
