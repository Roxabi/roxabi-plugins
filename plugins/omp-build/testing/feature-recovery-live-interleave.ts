import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FINDING_TARGET_FORMAT } from '../engine/finding-target-schema.ts'
import ompBuildExtension from '../omp/index.ts'
import { reviewControllerFor } from '../omp/omp-controller.ts'
import { createExtensionApiStub } from './extension-api-stub.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { releaseLiveInterleaveBarrier, waitForBarrier } from './feature-recovery-live-barrier.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import { type NativeReviewChild, nativeReviewChild } from './native-review-child.ts'

type Handler = (...args: unknown[]) => unknown

type CapturedBash = { toolCallId: string; exitCode: number }

type LiveInterleaveResult = {
  operationId: string
  cloneRetained: boolean
  activeAfterCompletion: boolean
  pushAttempted: boolean
  messages: string[]
  completionError: string | null
  captures: { red: CapturedBash; green: CapturedBash }
}

async function emit(events: Map<string, Handler[]>, event: string, ...args: unknown[]): Promise<void> {
  for (const handler of events.get(event) ?? []) {
    const result = await handler(...args)
    if (typeof result === 'object' && result !== null && 'block' in result && result.block === true)
      throw new Error(`${event} refused: ${'reason' in result ? String(result.reason) : 'unknown'}`)
  }
}

function gitExitCode(cwd: string, args: string[]): number {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' })
    return 0
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number')
      return error.status
    throw error
  }
}

async function captureBash(input: {
  child: NativeReviewChild
  command: string
  toolCallId: string
  cwd: string
  args: string[]
}): Promise<CapturedBash> {
  const toolInput = { command: input.command }
  await input.child.call('bash', input.toolCallId, toolInput)
  const exitCode = gitExitCode(input.cwd, input.args)
  await input.child.result('bash', input.toolCallId, toolInput, {
    content: [],
    details: { exitCode },
    isError: exitCode !== 0,
  })
  return { toolCallId: input.toolCallId, exitCode }
}

export async function invokeOmpLiveInterleave(cwd: string): Promise<LiveInterleaveResult> {
  const commands = new Map<string, Handler>()
  const events = new Map<string, Handler[]>()
  const messages: string[] = []
  const api = createExtensionApiStub({
    events: {
      on(name, handler) {
        const registered = events.get(name) ?? []
        registered.push(handler as Handler)
        events.set(name, registered)
        return () => undefined
      },
    },
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
  const artifacts = mkdtempSync(path.join(tmpdir(), 'recovery-live-'))
  const context = {
    cwd,
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    model: { contextWindow: 128_000 },
    models: { resolve: () => ({ id: 'fixture-model', provider: 'fixture-provider' }) },
    sessionManager: { getSessionId: () => 'recovery-live-root' },
    isIdle: () => true,
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  }
  const gate = mkdtempSync(path.join(tmpdir(), 'omp-build-authorize-push-'))
  const ready = path.join(gate, 'ready')
  const release = path.join(gate, 'release')
  const pushed = path.join(gate, 'pushed')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const wrapper = path.join(gate, 'git')
  writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = push ]; then : > "$OMP_BUILD_PUSHED"; fi
if [ "$1" = ls-remote ] && [ "$2" = origin ]; then
  : > "$OMP_BUILD_AUTHORIZE_READY"
  while [ ! -f "$OMP_BUILD_AUTHORIZE_RELEASE" ]; do sleep 0.01; done
fi
exec "$OMP_BUILD_REAL_GIT" "$@"
`,
  )
  chmodSync(wrapper, 0o755)
  const originalPath = process.env.PATH
  Object.assign(process.env, {
    PATH: `${gate}:${originalPath ?? ''}`,
    OMP_BUILD_AUTHORIZE_READY: ready,
    OMP_BUILD_AUTHORIZE_RELEASE: release,
    OMP_BUILD_PUSHED: pushed,
    OMP_BUILD_REAL_GIT: realGit,
  })
  let completing: Promise<void> | null = null
  try {
    ompBuildExtension(api, { principalCwd: () => false })
    await emit(events, 'session_start', { type: 'session_start' }, context)
    const feature = commands.get('feature')
    if (feature === undefined) throw new Error('feature-command-unregistered')
    await feature('#42', context)
    const controller = reviewControllerFor(api)
    const active = controller.active()
    if (active === null) throw new Error(`feature-batch-not-active: ${JSON.stringify(messages)}`)
    await controller.stopOwned(structuredClone(active), 'clone-must-not-stop')
    const cloneRetained = controller.active() === active
    const task = active.tasks.tasks[0]
    const wire = controller.wire(active)
    if (task === undefined || wire === null) throw new Error('feature-batch-unwired')
    await emit(events, 'tool_call', { toolName: 'task', toolCallId: active.operationId, input: wire }, context)
    await emit(
      events,
      'before_subagent_spawn',
      { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
      context,
    )
    const sessionFile = path.join(artifacts, 'child-0.jsonl')
    await emit(events, 'task:subagent:lifecycle', {
      status: 'started',
      id: task.name,
      agent: task.agent,
      index: 0,
      parentToolCallId: active.operationId,
      sessionFile,
      detached: false,
    })
    const child = await nativeReviewChild({ task, sessionFile })

    writeFileSync(path.join(cwd, 'README.md'), 'live interleaving witness\n')
    execFileSync('git', ['add', '--', 'README.md'], { cwd })
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'feat(feature): retain live pause witness (#42)'],
      { cwd },
    )
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    const redCommand = 'git diff --quiet HEAD^ HEAD -- README.md'
    const red = await captureBash({
      child,
      command: redCommand,
      toolCallId: 'implementation-proof-red',
      cwd,
      args: ['diff', '--quiet', 'HEAD^', 'HEAD', '--', 'README.md'],
    })
    if (red.exitCode !== 1) throw new Error(`red-proof-exit-code:${red.exitCode}`)
    const green = await captureBash({
      child,
      command: 'git diff --quiet HEAD',
      toolCallId: 'implementation-proof-green',
      cwd,
      args: ['diff', '--quiet', 'HEAD'],
    })
    if (green.exitCode !== 0) throw new Error(`green-proof-exit-code:${green.exitCode}`)
    const proofCommand = 'git diff --quiet HEAD'
    const output = {
      outcome: 'implemented' as const,
      commitSHAs: [tip],
      commands: [
        { toolCallId: red.toolCallId, command: redCommand, exitCode: red.exitCode },
        { toolCallId: green.toolCallId, command: proofCommand, exitCode: green.exitCode },
      ],
      criteria: [
        {
          target: {
            format: FINDING_TARGET_FORMAT,
            kind: 'criterion' as const,
            spec: {
              uw: SCOPE,
              version: nativeFeatureSpec(SCOPE, 'preserves the region').ownSpec.version,
              sourceAccepted: { scope: SCOPE, recordId: 'mandate-feature-1', kind: 'mandate' as const },
            },
            id: 'C1',
          },
          verification: 'unverified' as const,
          reason: 'the captured commands exercise the pause interleaving, not criterion evidence',
        },
      ],
      reason: 'the captured command exercises the changed path',
    }
    await child.call('yield', 'implementation-yield', { data: output })
    await child.result('yield', 'implementation-yield', { data: output }, { content: [], details: {}, isError: false })
    const resultEvent = emit(
      events,
      'tool_result',
      {
        toolName: 'task',
        toolCallId: active.operationId,
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: task.name,
              agent: task.agent,
              exitCode: 0,
              structuredOutput: { status: 'valid', data: output },
            },
          ],
        },
      },
      context,
    )
    completing = resultEvent.then(() => controller.ownedSettlement()).then(() => undefined)
    await waitForBarrier(() => existsSync(ready), completing)
    await feature('pause #42', context)
    writeFileSync(release, '')
    let completionError: string | null = null
    try {
      await completing
    } catch (error) {
      completionError = error instanceof Error ? error.message : String(error)
    }
    return {
      operationId: active.operationId,
      cloneRetained,
      activeAfterCompletion: controller.active() !== null,
      pushAttempted: existsSync(pushed),
      messages,
      completionError,
      captures: { red, green },
    }
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
    await releaseLiveInterleaveBarrier(release, completing, originalPath, gate)
  }
}
