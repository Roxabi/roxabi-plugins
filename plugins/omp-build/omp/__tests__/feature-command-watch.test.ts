import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureWorkflow } from '../../roxabi/feature-contract'
import { pauseOwnedFeatureOnSessionEnd } from '../../roxabi/feature-host-lifetime'
import { rememberFeatureOwner } from '../../roxabi/feature-host-ownership'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { cleanupFixtureActions, batch as nativeBatch } from '../../testing/review-runtime-support'
import ompBuildExtension from '../index'
import type { OmpBuildExtensionOptions } from '../omp-commands'
import { reviewControllerFor } from '../omp-controller'
import type { NativeExtension } from '../review-runtime/contracts'

type CapturedHandler = {
  invoke(...args: unknown[]): unknown
}['invoke']

const root = {
  ...consultableAgentRoot(),
  cwd: '/repo/feature',
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

afterEach(() => {
  cleanupFixtureActions()
})

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow & { pauses: string[] } {
  const pauses: string[] = []
  return {
    pauses,
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
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
  const sessions = new Map<string, CapturedHandler>()
  const registered = new Map<string, CapturedHandler[]>()

  const pi = createExtensionApiStub({
    on: (event, handler) => {
      const listeners = registered.get(event) ?? []
      listeners.push(handler)

      registered.set(event, listeners)
      sessions.set(event, async (session, ctx) => {
        for (const listener of listeners) {
          const result = await listener(session, ctx)
          if (result !== undefined) return result
        }
      })
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
  return { pi, sent, commands, sessions }
}

describe('installed /feature command CI watch', () => {
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

  it('pauses a started native feature action on a user interrupt', async () => {
    const pauses: string[] = []
    const followUp = nativeBatch(['R-workflow-plan'])
    const featureWorkflow = workflow({
      continueFeature: async () => ({
        kind: 'action',
        node: 'plan',
        followUp,
        start: {
          scope: { repository: 'acme/app', target: 'acme/app#42' },
          recordId: 'plan-start',
          kind: 'action-receipt',
        },
      }),
      requestFeatureSessionPause: async (input) => {
        pauses.push(input.reason)
        return { kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }
      },
    })
    const host = installed({ featureWorkflow })
    await host.commands.get('feature')?.handler('#42', root)
    expect(reviewControllerFor(host.pi as NativeExtension).active()).toBe(followUp)
    await host.sessions.get('message_end')?.(
      { message: { role: 'assistant', stopReason: 'aborted', errorId: 67108864 } } as never,
      root,
    )
    expect(pauses).toEqual(['session-stop'])
  })

  it('does not pause a new feature when an older session interrupt completes late', async () => {
    const key = {}
    const paused: string[] = []
    const deferred = Promise.withResolvers<void>()
    const featureWorkflow = workflow({
      requestFeatureSessionPause: async (input) => {
        paused.push(input.reference ?? '')
        return { kind: 'paused', confirmed: true, reason: 'saved' }
      },
    })
    rememberFeatureOwner(key, { reference: '#41', cwd: '/repo/a', pausable: true })
    const oldPause = pauseOwnedFeatureOnSessionEnd(key, 'session-switch', featureWorkflow, () => deferred.promise)
    rememberFeatureOwner(key, { reference: '#42', cwd: '/repo/b', pausable: true })
    deferred.resolve()
    await oldPause

    expect(paused).toEqual([])

    await pauseOwnedFeatureOnSessionEnd(key, 'session-switch', featureWorkflow, async () => undefined)
    expect(paused).toEqual(['#42'])
  })

  it('does not pause when shutdown follows a completed feature', async () => {
    const featureWorkflow = workflow({
      continueFeature: async () => ({ kind: 'terminal', reason: 'done' }),
    })
    const host = installed({ featureWorkflow })
    await host.commands.get('feature')?.handler('#12', root)
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
