import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreparedEpicReview } from '../../roxabi/epic-range-review'
import {
  type FeatureWorkflow,
  featureOwner,
  featureSessionCwdMessage,
  parseFeatureCommand,
  runInstalledFeatureCommand,
} from '../../roxabi/feature-entry'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles'
import ompBuildExtension, { type OmpBuildExtensionOptions } from '../index'
import {
  installNativeBatchBridge,
  type NativeBatch,
  NativeBatchController,
  type NativeExtension,
} from '../review-runtime'
import { createExtensionApiStub } from './extension-api-stub'

const reviewStage = vi.hoisted(() => ({
  completeStage: async () => null as unknown,
}))

vi.mock('../../skills/feature/workflow.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nextReviewStep: async () => ({ action: 'review' }),
  validateReviewInput: async () => ({ ok: true }),
}))

vi.mock('../../roxabi/review-entry', () => ({
  createPreparedReviewRunner: () => {
    const prepared = {
      stage: 'synthesis',
      batch: {
        operationId: 'final-review',
        tasks: {
          context: 'final review fixture',
          tasks: [{ name: 'synthesis', agent: 'R-review-synthesis', task: 'synthesize', solutionSpace: 'fixture' }],
        },
      },
    }
    return {
      context: {
        repository: 'acme/widgets',
        target: 'acme/widgets#12',
        number: 12,
        candidateGitSHA: 'a'.repeat(40),
        input: null,
        runId: 'review-run',
        operationId: 'final-review',
        subject: { kind: 'pull-request' },
      },
      initialBatch: () => prepared,
      authorize: async () => ({ ok: true }),
      publishInventory: async () => ({ ok: true }),
      publishRawContribution: async () => ({ recordId: 'contribution' }),
      completeStage: reviewStage.completeStage,
      publishRequiredStop: async () => undefined,
      stop: async () => undefined,
    }
  },
}))

const fixtureRoots = new Set<string>()

const root = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

function nativeFixtureRoot() {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-build-feature-command-'))
  fixtureRoots.add(cwd)
  mkdirSync(join(cwd, '.dev'))
  writeFileSync(join(cwd, '.dev', 'stack.yml'), 'package_manager: bun\n')
  return { ...root, cwd }
}

afterEach(() => {
  for (const cwd of fixtureRoots) rmSync(cwd, { recursive: true, force: true })
  fixtureRoots.clear()
})

function batch(operationId = 'feature-op'): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'feature fixture',
      tasks: [{ name: 'R-workflow-plan', agent: 'R-advisor', task: 'plan', solutionSpace: 'fixed fixture' }],
    },
  }
}

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow & { pauses: string[] } {
  const pauses: string[] = []
  return {
    pauses,
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => ({ published: true }),
    requestFeatureSessionPause: async (input) => {
      pauses.push(input.reason)
      return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
    },
    ...impl,
  }
}

function installed(
  options: OmpBuildExtensionOptions,
  exec?: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>,
) {
  const sent: string[] = []
  const commands = new Map<string, { handler: (args: string, ctx: typeof root) => Promise<void> }>()
  const sessions = new Map<string, (event: { signal: AbortSignal }, ctx: typeof root) => void | Promise<void>>()
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const registered = new Map<string, Array<(...args: never[]) => unknown>>()
  const raw = new Map<string, (value: unknown) => void>()
  const registeredRaw = new Map<string, Array<(value: unknown) => void>>()
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      const listeners = registered.get(event) ?? []
      listeners.push(handler as (...args: never[]) => unknown)
      registered.set(event, listeners)
      const dispatch = async (...args: never[]) => {
        for (const listener of listeners) {
          const result = await listener(...args)
          if (result !== undefined) return result
        }
      }
      handlers.set(event, dispatch)
      sessions.set(event, async (session, ctx) => {
        await dispatch(session as never, ctx as never)
      })
    },
    events: {
      on: (event, handler) => {
        const listeners = registeredRaw.get(event) ?? []
        listeners.push(handler as (value: unknown) => void)
        registeredRaw.set(event, listeners)
        raw.set(event, (value) => {
          for (const listener of listeners) listener(value)
        })
        return () => undefined
      },
    },
    registerCommand: (name, command) => {
      commands.set(name, command as { handler: (args: string, ctx: typeof root) => Promise<void> })
    },
    sendUserMessage: (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
    ...(exec === undefined ? {} : { exec }),
  })
  ompBuildExtension(pi, { principalCwd: () => false, ...options })
  return { sent, commands, sessions, handlers, raw, pi }
}

describe('installed /feature command', () => {
  it('returns session-cwd and /move on the principal and does not announce a batch', async () => {
    const calls: string[] = []
    const host = installed({
      principalCwd: () => true,
      featureWorkflow: workflow({
        continueFeature: async (input) => {
          calls.push(input.control)
          return { kind: 'session-cwd', path: input.cwd, instruction: `/move ${input.cwd}` }
        },
      }),
    })
    await host.commands.get('feature')?.handler('#12', root)
    expect(calls).toEqual(['select'])
    expect(host.sent).toEqual([featureSessionCwdMessage('/repo/feature', '/move /repo/feature')])
    expect(host.sent.join('\n')).not.toContain('OMP_BUILD_NATIVE_BATCH')
    expect(host.sent.join('\n')).not.toContain('disarmed')
  })

  it('announces one prepared batch for a non-principal selection and does not dump the skill', async () => {
    const prepared = batch()
    const host = installed({
      principalCwd: () => false,
      featureWorkflow: workflow({
        continueFeature: async () => ({
          kind: 'action',
          followUp: prepared,
          start: {
            scope: { repository: 'acme/widgets', target: 'acme/widgets#12' },
            recordId: 'action-start-1',
            kind: 'action-receipt',
          },
        }),
      }),
    })
    await host.commands.get('feature')?.handler('#12', root)
    const announced = host.sent.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))
    expect(announced).toHaveLength(1)
    expect(announced[0]).toContain('R-workflow-plan')
    expect(host.sent.join('\n')).not.toContain('# Feature')
    expect(host.sent.join('\n')).not.toContain('[Skill directory:')
  })

  it('settles the final review result after announcing a fix, then continues only when that fix terminal completes', async () => {
    let fixPrepared = false
    const terminal = Promise.withResolvers<{ status: 'complete'; recordId: string; kind: 'fix-result' }>()
    const ctx = nativeFixtureRoot()
    const host = installed({
      prepareReview: async () =>
        ({
          ok: true,
          value: { pr: { number: 12, head: 'a'.repeat(40) }, capture: { input: null }, automationLogin: 'roxabi-bot' },
        }) as never,
      startFeatureFix: async () => {
        fixPrepared = true
        return { terminal: terminal.promise }
      },
      featureWorkflow: workflow({
        continueFeature: async (input) => {
          if (input.control === 'select') return { kind: 'review', pr: 12 }
          if (!fixPrepared) return { kind: 'fix', reference: 'fix-record' }
          throw new Error('post-fix-continuation-rejected')
        },
      }),
    })

    await host.commands.get('feature')?.handler('#12', ctx)
    const announced = host.sent.find((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))
    if (announced === undefined) throw new Error('expected final review native batch')
    const { i: _intent, ...input } = JSON.parse(announced.split('\n')[1]) as { i: string }
    const admission = await (
      host.handlers.get('tool_call') as ((event: unknown, ctx: typeof root) => Promise<unknown>) | undefined
    )?.({ toolName: 'task', toolCallId: 'final-review-call', input }, ctx)
    expect(admission).toBeUndefined()
    const spawn = await (
      host.handlers.get('before_subagent_spawn') as ((event: unknown, ctx: typeof root) => Promise<unknown>) | undefined
    )?.({ invocationKind: 'task', spawnKey: 'synthesis', agent: 'R-review-synthesis' }, ctx)
    expect(spawn).toBeUndefined()
    host.raw.get('task:subagent:event')?.({
      id: 'synthesis-child',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'synthesis-yield',
        args: { data: { plan: [] } },
      },
    })
    await (host.handlers.get('tool_result') as ((event: unknown, ctx: typeof root) => Promise<void>) | undefined)?.(
      {
        toolName: 'task',
        toolCallId: 'final-review-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'synthesis-child',
              agent: 'R-review-synthesis',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { plan: [] } },
            },
          ],
        },
      },
      ctx,
    )

    expect(fixPrepared).toBe(true)
    terminal.resolve({ status: 'complete', recordId: 'fix-record', kind: 'fix-result' })
    await terminal.promise
    await vi.waitFor(() =>
      expect(host.sent.filter((message) => message === 'feature-stopped: post-fix-continuation-rejected')).toHaveLength(
        1,
      ),
    )
  })

  it('registers a pausable owner for a fresh review session and disarms it on supported interruption', async () => {
    const pauses: string[] = []
    const host = installed({
      prepareReview: async () =>
        ({
          ok: true,
          value: { pr: { number: 12, head: 'a'.repeat(40) }, capture: { input: null }, automationLogin: 'roxabi-bot' },
        }) as never,
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'review', pr: 12 }),
        requestFeatureSessionPause: async (input) => {
          pauses.push(input.reason)
          return { kind: 'paused', confirmed: true, reason: 'operator' }
        },
      }),
    })

    await host.commands.get('feature')?.handler('#12', root)
    expect(featureOwner(host.pi)).toMatchObject({ reference: '12', cwd: root.cwd, pausable: true })
    await host.sessions.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'aborted', errorId: 67108864 } } as never,
      root,
    )

    expect(pauses).toEqual(['session-stop'])
    expect(host.sent).toContain('pause-confirmed: operator')
    expect(host.sent.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
  })

  it('honors a local confirmed interruption while final publication is pending', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const ctx = nativeFixtureRoot()
    reviewStage.completeStage = async () => {
      entered.resolve()
      await gate.promise
      return null
    }
    const host = installed({
      prepareReview: async () =>
        ({
          ok: true,
          value: { pr: { number: 12, head: 'a'.repeat(40) }, capture: { input: null }, automationLogin: 'roxabi-bot' },
        }) as never,
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'review', pr: 12 }),
        requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: true, reason: 'operator' }),
      }),
    })
    await host.commands.get('feature')?.handler('#12', ctx)
    const announced = host.sent.find((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))
    if (announced === undefined) throw new Error('expected final review native batch')
    const { i: _intent, ...input } = JSON.parse(announced.split('\n')[1]) as { i: string }
    const admission = await (
      host.handlers.get('tool_call') as ((event: unknown, ctx: typeof root) => Promise<unknown>) | undefined
    )?.({ toolName: 'task', toolCallId: 'pause-review-call', input }, ctx)
    expect(admission).toBeUndefined()
    const spawn = await (
      host.handlers.get('before_subagent_spawn') as ((event: unknown, ctx: typeof root) => Promise<unknown>) | undefined
    )?.({ invocationKind: 'task', spawnKey: 'synthesis', agent: 'R-review-synthesis' }, ctx)
    expect(spawn).toBeUndefined()
    host.raw.get('task:subagent:event')?.({
      id: 'synthesis-child',
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: 'pause-synthesis-yield',
        args: { data: { plan: [] } },
      },
    })
    const settled = (
      host.handlers.get('tool_result') as ((event: unknown, ctx: typeof root) => Promise<void>) | undefined
    )?.(
      {
        toolName: 'task',
        toolCallId: 'pause-review-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'synthesis-child',
              agent: 'R-review-synthesis',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { plan: [] } },
            },
          ],
        },
      },
      ctx,
    )
    await entered.promise
    await host.sessions.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'aborted', errorId: 67108864 } } as never,
      ctx,
    )
    gate.resolve()
    await settled

    expect(host.sent.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(1)
    expect(host.sent).toContain('pause-confirmed: operator')
    reviewStage.completeStage = async () => null
  })

  it('confirms pause only from the product and never prints disarmed for an unconfirmed pause', async () => {
    const confirmed = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'paused', confirmed: true, reason: 'operator' }),
      }),
    })
    await confirmed.commands.get('feature')?.handler('pause #12', root)
    expect(confirmed.sent).toEqual(['pause-confirmed: operator'])

    const unconfirmed = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'paused', confirmed: false, reason: 'product said disarmed' }),
      }),
    })
    await unconfirmed.commands.get('feature')?.handler('pause #12', root)
    expect(unconfirmed.sent).toEqual(['pause-unconfirmed: pause-unconfirmed'])
    expect(unconfirmed.sent.join('\n')).not.toContain('disarmed')
  })

  it('does not claim abandoned unless the product confirmed publication', async () => {
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async () => ({ kind: 'abandoned', confirmed: false }),
      }),
    })
    await host.commands.get('feature')?.handler('abandon #12', root)
    expect(host.sent).toEqual(['feature-stopped: abandon-unconfirmed'])
    expect(host.sent.join('\n')).not.toContain('feature-abandoned')
  })

  it('forwards a multi-token subject for assisted framing and does not reject it', async () => {
    const references: string[] = []
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async (input) => {
          references.push(input.reference)
          return { kind: 'operator-decision', reason: 'needs-framing' }
        },
      }),
    })
    await host.commands.get('feature')?.handler('ship the billing export', root)
    expect(references).toEqual(['ship the billing export'])
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).not.toMatch(/^feature-stopped/)
    expect(host.sent.join('\n')).not.toContain('feature-reference-invalid')
    expect(host.sent.join('\n')).not.toContain('operator-decision:needs-scope')
  })

  it('refuses needs-scope without assisted framing and without dispatching a batch', async () => {
    let activated = false
    let announced = false

    const sent: string[] = []
    await runInstalledFeatureCommand('#12', {
      key: {},
      cwd: root.cwd,
      principal: false,
      workflow: workflow({
        continueFeature: async () => ({ kind: 'operator-decision', reason: 'needs-scope' }),
      }),
      native: {
        activate: () => {
          activated = true
        },
        inactive: () => undefined,
        stopOwned: async () => undefined,
        announce: async () => {
          announced = true
        },
      },
      send: async (text) => {
        sent.push(text)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      exec: async () => ({ code: 0, killed: false }),
    })
    expect(sent).toEqual(['feature-stopped: operator-decision:needs-scope'])
    expect(activated).toBe(false)
    expect(announced).toBe(false)
  })

  it('forwards an explicit material decision and rejects a missing reference before the workflow', async () => {
    const decisions: string[] = []
    const host = installed({
      featureWorkflow: workflow({
        continueFeature: async (input) => {
          decisions.push(input.decision ?? '')
          return { kind: 'operator-decision', reason: 'recorded' }
        },
      }),
    })
    await host.commands.get('feature')?.handler('material-decision #12 accept', root)
    await host.commands.get('feature')?.handler('', root)
    expect(decisions).toEqual(['accept'])
    expect(host.sent[1]).toBe('feature-stopped: feature-reference-missing')
  })

  it('does not product-pause or abort CI watch on ordinary session_stop settle', async () => {
    const pauses: string[] = []
    let aborted = false
    const featureWorkflow = workflow({
      continueFeature: async () => ({
        kind: 'watch',
        command: "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'",
      }),
      requestFeatureSessionPause: async (input) => {
        pauses.push(input.reason)
        return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
      },
    })
    const host = installed({ featureWorkflow }, (_command, _args, options) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>(() => undefined)
    })
    await host.commands.get('feature')?.handler('#12', root)
    const stop = host.sessions.get('session_stop')
    expect(stop).toBeTypeOf('function')
    await stop?.({ signal: new AbortController().signal }, root)
    expect(pauses).toEqual([])
    expect(aborted).toBe(false)
    expect(host.sent.join('\n')).toContain('ci-watch: running')
    expect(host.sent.join('\n')).not.toContain('pause-unconfirmed')
    expect(host.sent.join('\n')).not.toContain('pause-confirmed')
  })

  it('pauses on mid-turn user-interrupt message_end stamped with Flag.UserInterrupt', async () => {
    const pauses: string[] = []
    const { promise: paused, resolve: markPaused } = Promise.withResolvers<void>()
    let aborted = false
    const featureWorkflow = workflow({
      continueFeature: async () => ({
        kind: 'watch',
        command: "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'",
      }),
      requestFeatureSessionPause: async (input) => {
        pauses.push(input.reason)
        markPaused()
        return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
      },
    })
    const host = installed({ featureWorkflow }, (_command, _args, options) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise<{ code: number; killed: boolean; stdout: string; stderr: string }>(() => undefined)
    })
    await host.commands.get('feature')?.handler('#12', root)
    const onMessageEnd = host.sessions.get('message_end')
    expect(onMessageEnd).toBeTypeOf('function')
    // SDK session-boundary Esc/RPC stamps Flag.UserInterrupt (1<<26) on errorId before message_end.
    await onMessageEnd?.(
      {
        message: {
          role: 'assistant',
          stopReason: 'aborted',
          errorId: 67108864,
        },
      } as never,
      root,
    )
    await paused
    expect(pauses).toEqual(['session-stop'])
    expect(aborted).toBe(true)
    expect(host.sent.join('\n')).toContain('pause-unconfirmed:')
    expect(host.sent.join('\n')).not.toContain('pause-confirmed')
    expect(host.sent.join('\n')).not.toContain('disarmed')
  })

  it('does not append a pause when shutdown follows a completed feature', async () => {
    const featureWorkflow = workflow({
      continueFeature: async () => ({ kind: 'terminal', reason: 'done' }),
    })
    const host = installed({ featureWorkflow })
    await host.commands.get('feature')?.handler('#12', root)
    expect(featureOwner(host.pi)).toBeUndefined()
    await host.sessions.get('session_shutdown')?.({ signal: new AbortController().signal }, root)
    expect(featureWorkflow.pauses).toEqual([])
    expect(host.sent).toEqual(['feature-stopped: done'])
  })

  it('executes the existing ci-watch command once and feeds a real exit to the coordinator', async () => {
    const seen: Array<string | number> = []
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>()
    const host = installed(
      {
        featureWorkflow: workflow({
          continueFeature: async () => ({
            kind: 'watch',
            command:
              "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '88' --merge-mode native --base 'main' --since '2026-10-21T00:00:00Z'",
          }),
          consumeWatchExit: async (input) => {
            seen.push(input.cwd, input.pr, input.code, input.reference)
            markExited()
            return { kind: 'terminal', reason: 'merged' }
          },
        }),
      },
      async (command, args) => {
        seen.push(command, args.join('\n'))
        return { code: 0, killed: false, stdout: '', stderr: '' }
      },
    )
    await host.commands.get('feature')?.handler('#12', root)
    await exited
    await Promise.resolve()
    expect(seen).toEqual([
      'bash',
      '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh\n88\n--merge-mode\nnative\n--base\nmain\n--since\n2026-10-21T00:00:00Z',
      '/repo/feature',
      88,
      0,
      '12',
    ])
    expect(host.sent.join('\n')).not.toContain('OMP_BUILD_CI_WATCH')
  })

  it('does not treat a killed watch as completion', async () => {
    const exits: number[] = []
    const host = installed(
      {
        featureWorkflow: workflow({
          consumeWatchExit: async (input) => {
            exits.push(input.code)
            return { kind: 'terminal', reason: 'merged' }
          },
          continueFeature: async () => ({
            kind: 'watch',
            command:
              "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'",
          }),
        }),
      },
      async () => ({ code: -1, killed: true, stdout: '', stderr: '' }),
    )
    await host.commands.get('feature')?.handler('#12', root)
    await Promise.resolve()
    expect(exits).toEqual([])
  })

  it('refuses a watch command that is not the existing ci-watch invocation', async () => {
    let executed = false
    const host = installed(
      {
        featureWorkflow: workflow({
          continueFeature: async () => ({ kind: 'watch', command: 'ci-watch.sh' }),
        }),
      },
      async () => {
        executed = true
        return { code: 0, killed: false, stdout: '', stderr: '' }
      },
    )
    await host.commands.get('feature')?.handler('#12', root)
    expect(executed).toBe(false)
    expect(host.sent).toEqual(['feature-stopped: watch-command-invalid'])
  })
})

describe('feature command grammar', () => {
  it('accepts a reference, explicit resume, and a material decision without treating resume as a second confirmation', () => {
    expect(parseFeatureCommand('#12')).toEqual({ ok: true, control: 'select', reference: '12' })
    expect(parseFeatureCommand('resume 12')).toEqual({ ok: true, control: 'resume', reference: '12' })
    expect(parseFeatureCommand('new feature-subject')).toEqual({
      ok: true,
      control: 'new',
      reference: 'feature-subject',
    })
    expect(parseFeatureCommand('material-decision #9 reject')).toEqual({
      ok: true,
      control: 'material-decision',
      reference: '9',
      decision: 'reject',
    })
    expect(parseFeatureCommand('pause')).toEqual({ ok: false, reason: 'feature-reference-missing' })
    expect(parseFeatureCommand('material-decision #9 maybe')).toEqual({
      ok: false,
      reason: 'feature-material-decision-invalid',
    })
  })
})

describe('feature init route', () => {
  it('keeps init and dry-run off framing and does not invent apply approval', async () => {
    expect(parseFeatureCommand('init')).toEqual({ ok: true, control: 'init', args: [] })
    expect(parseFeatureCommand('init --dry-run')).toEqual({ ok: true, control: 'init', args: ['--dry-run'] })
    expect(parseFeatureCommand("init --approve abc --operator-approval 'ship it'")).toEqual({
      ok: true,
      control: 'init',
      args: ['--approve', 'abc', '--operator-approval', 'ship it'],
    })
    expect(parseFeatureCommand('new init')).toEqual({ ok: true, control: 'new', reference: 'init' })
    expect(parseFeatureCommand("init --operator-approval 'unterminated")).toEqual({
      ok: false,
      reason: 'feature-init-invalid',
    })

    const calls: string[] = []
    const execs: { command: string; args: string[]; cwd?: string }[] = []
    const sent: string[] = []
    let activated = false
    const host = {
      key: {},
      cwd: '/candidate/checkout',
      principal: true,
      workflow: workflow({
        continueFeature: async () => {
          calls.push('continue')
          return { kind: 'operator-decision', reason: 'needs-framing' }
        },
      }),
      native: {
        activate: () => {
          activated = true
        },
        inactive: () => undefined,
        stopOwned: async () => undefined,
        announce: async () => undefined,
      },
      send: async (text: string) => {
        sent.push(text)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      git: async (args: readonly string[], cwd: string) => {
        calls.push(`git:${cwd}:${args.join(' ')}`)
        return { stdout: '/captured/target\n', exitCode: 0 }
      },
      exec: async (command: string, args: string[], options?: { cwd?: string }) => {
        calls.push('exec')
        execs.push({ command, args, cwd: options?.cwd })
        return { code: 0, killed: false, stdout: 'digest: abc\ndigest is not authorization\n' }
      },
    }

    await runInstalledFeatureCommand('init', host)
    await runInstalledFeatureCommand('init --dry-run', host)
    await runInstalledFeatureCommand("init --approve abc --operator-approval 'ship it'", host)

    expect(calls.filter((call) => call === 'continue')).toEqual([])
    expect(activated).toBe(false)
    expect(calls.indexOf('git:/candidate/checkout:rev-parse --show-toplevel')).toBeLessThan(calls.indexOf('exec'))
    expect(execs).toHaveLength(3)
    for (const exec of execs) {
      expect(exec.command).toBe('bun')
      expect(exec.cwd).toMatch(/\/skills\/feature$/)
      expect(exec.cwd).not.toBe('/candidate/checkout')
      expect(exec.args[0]).toBe('--no-env-file')
      expect(exec.args[1]).toMatch(/\/skills\/feature\/feature-init\.ts$/)
      expect(exec.args.slice(2, 4)).toEqual(['--dir', '/captured/target'])
    }
    expect(execs[0]?.args.slice(4)).toEqual([])
    expect(execs[1]?.args.slice(4)).toEqual(['--dry-run'])
    expect(execs[2]?.args.slice(4)).toEqual(['--approve', 'abc', '--operator-approval', 'ship it'])
    expect(execs[0]?.args).not.toContain('--approve')
    expect(execs[1]?.args).not.toContain('--approve')
    expect(sent).toEqual([
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
    ])
  })

  it('does not launch init or framing when the target capture fails', async () => {
    let executed = false
    let continued = false
    const sent: string[] = []
    await runInstalledFeatureCommand('init --dry-run', {
      key: {},
      cwd: '/candidate/checkout',
      principal: false,
      workflow: workflow({
        continueFeature: async () => {
          continued = true
          return { kind: 'blocked', reason: 'unconfigured' }
        },
      }),
      native: {
        activate: () => undefined,
        inactive: () => undefined,
        stopOwned: async () => undefined,
        announce: async () => undefined,
      },
      send: async (text: string) => {
        sent.push(text)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      git: async () => ({ stdout: '', exitCode: 1 }),
      exec: async () => {
        executed = true
        return { code: 0, killed: false, stdout: '', stderr: '' }
      },
    })
    expect(executed).toBe(false)
    expect(continued).toBe(false)
    expect(sent).toEqual(['feature-stopped: feature-init-target-unobserved'])
  })
})

describe('feature continuation seam', () => {
  it('drops an undelivered feature follow-up while continuation is inhibited', () => {
    const controller = new NativeBatchController()
    const prepared = batch('held')
    controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(prepared)
    expect(controller.announce(prepared)).toBe(true)
    controller.inhibitFeatureContinuation()
    expect(controller.consumeFollowUp()).toBeNull()
    controller.inactive()
    const next = batch('blocked')
    controller.activate(next, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(next)
    expect(controller.announce(next)).toBe(false)
    controller.releaseFeatureContinuation()
    expect(controller.featureContinuationInhibited()).toBe(false)
    expect(controller.announce(next)).toBe(true)
  })

  it('calls onSettled once after a confirmed complete result and not from agent_end', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    let raw: ((value: unknown) => void) | undefined
    const pi = {
      events: {
        on: (_event: string, handler: (value: unknown) => void) => {
          raw = handler
        },
      },
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      sendUserMessage: async () => undefined,
    } as unknown as NativeExtension
    const controller = new NativeBatchController()
    installNativeBatchBridge(pi, controller)
    const prepared = batch('settled')
    let completed = 0
    let settled = 0
    controller.observeRootContext(root as never)
    controller.activate(prepared, {
      onComplete: async () => {
        completed += 1
      },
      onSettled: async () => {
        settled += 1
      },
      onStop: async () => undefined,
    })
    controller.announce(prepared)
    await handlers.get('tool_call')?.(
      { toolName: 'task', toolCallId: 'task-call', input: controller.wire(prepared) },
      root,
    )
    await handlers.get('before_subagent_spawn')?.(
      { agent: 'R-advisor', invocationKind: 'task', patterns: [], spawnKey: 'R-workflow-plan' },
      root,
    )
    raw?.({
      id: 'child-1',
      event: { type: 'tool_execution_start', toolName: 'yield', toolCallId: 'yield-1', args: { data: { plan: [] } } },
    })
    await handlers.get('tool_result')?.(
      {
        toolName: 'task',
        toolCallId: 'task-call',
        isError: false,
        content: [],
        details: {
          results: [
            {
              index: 0,
              id: 'child-1',
              agent: 'R-advisor',
              exitCode: 0,
              structuredOutput: { status: 'valid', data: { plan: [] } },
            },
          ],
        },
      },
      root,
    )
    await handlers.get('agent_end')?.({ willContinue: false }, root)
    expect(completed).toBe(1)
    expect(settled).toBe(1)
  })
})

describe('native feature profiles', () => {
  it('keeps the four missing actions blocking and separate from the specialist plan review', () => {
    const byName = new Map(nativeFeatureProfiles.map((profile) => [profile.name, profile]))
    expect(byName.get('R-workflow-assess-spec')?.output).toBe('spec-assessment')
    expect(byName.get('R-workflow-plan')?.output).toBe('plan')
    expect(byName.get('R-workflow-implement')?.output).toBe('implementation')
    expect(byName.get('R-workflow-attribute-ci')?.output).toBe('ci-attribution')
    expect(byName.get('R-workflow-plan')?.body).toContain('criterion')
    expect(byName.get('R-workflow-plan')?.body).toContain('paths')
    expect(byName.get('R-workflow-assess-spec')?.body).toContain('exact accepted Spec snapshot')
    expect(byName.get('R-workflow-plan-architect')?.tools).not.toContain('write')
    expect(byName.get('R-workflow-plan-adversarial')?.tools).not.toContain('edit')
  })
})

describe('principal refusal stays one message', () => {
  it('sends the move instruction once when the workflow returns it', async () => {
    const sent: string[] = []
    await runInstalledFeatureCommand('#4', {
      key: {},
      cwd: '/principal',
      principal: true,
      workflow: workflow({
        continueFeature: async (input) => ({ kind: 'session-cwd', path: input.cwd, instruction: `/move ${input.cwd}` }),
      }),
      native: {
        activate() {},
        inactive() {},
        async stopOwned() {},
        async announce() {},
      },
      send: async (message) => {
        sent.push(message)
      },
      inhibitFeatureContinuation() {},
      releaseFeatureContinuation() {},
      featureContinuationInhibited: () => false,
      markFeatureBatch() {},
      exec: async () => ({ code: -1, killed: true }),
    })
    expect(sent).toEqual([featureSessionCwdMessage('/principal', '/move /principal')])
  })
})

describe('prepared epic final review delivery', () => {
  const review: PreparedEpicReview = {
    context: {
      repository: 'acme/widgets',
      target: 'acme/widgets#12',
      number: 12,
      candidateGitSHA: 'b'.repeat(40),
      input: null,
      runId: 'review-run',
      operationId: 'final-review',
      subject: { kind: 'epic-range', range: `${'a'.repeat(40)}..${'b'.repeat(40)}` },
    },
    prepared: {
      stage: 'synthesis',
      rootAttemptId: 'root-attempt',
      inventory: {},
      batch: batch('final-review'),
    },
    publisher: {
      authorize: async () => ({ ok: true }),
      publishInventory: async () => ({ ok: true }),
      publishRawContribution: async (_prepared, child) => ({ id: 'contribution', child }),
      completeStage: async () => null,
      publishRequiredStop: async () => ({ ok: true }),
      stop: async () => undefined,
    },
  }

  function host(
    continueFeature: FeatureWorkflow['continueFeature'],
    prepareEpicRangeReview: (preparedReview: PreparedEpicReview, onComplete: () => Promise<void>) => Promise<void>,
    inhibited = () => false,
  ) {
    const sent: string[] = []
    return {
      sent,
      value: {
        key: {},
        cwd: root.cwd,
        principal: false,
        workflow: workflow({ continueFeature }),
        native: { activate() {}, inactive() {}, async stopOwned() {}, async announce() {} },
        send: async (message: string) => {
          sent.push(message)
        },
        inhibitFeatureContinuation() {},
        releaseFeatureContinuation() {},
        featureContinuationInhibited: inhibited,
        markFeatureBatch() {},
        prepareEpicRangeReview,
        exec: async () => ({ code: -1, killed: true }),
      },
    }
  }

  it('does not continue when final epic publication fails', async () => {
    let continued = false
    const fixture = host(
      async (input) => {
        if (input.control === 'select') return { kind: 'epic-final-review', review }
        continued = true
        return { kind: 'terminal', reason: 'unexpected' }
      },
      async () => {
        throw new Error('epic-final-publication-failed')
      },
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(continued).toBe(false)
    expect(fixture.sent).toEqual(['feature-stopped: epic-final-publication-failed'])
  })

  it('continues after confirmed final epic publication', async () => {
    const fixture = host(
      async (input) =>
        input.control === 'select' ? { kind: 'epic-final-review', review } : { kind: 'terminal', reason: 'complete' },
      async (_review, onComplete) => onComplete(),
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(fixture.sent).toEqual(['feature-stopped: complete'])
  })

  it('does not start next work when epic publication completes under pause inhibition', async () => {
    let inhibited = false
    let continued = false
    const fixture = host(
      async (input) => {
        if (input.control === 'select') return { kind: 'epic-final-review', review }
        continued = true
        return { kind: 'terminal', reason: 'unexpected' }
      },
      async (_review, onComplete) => {
        inhibited = true
        await onComplete()
      },
      () => inhibited,
    )
    await runInstalledFeatureCommand('#12', fixture.value)
    expect(continued).toBe(false)
    expect(fixture.sent).toEqual([])
  })
})
