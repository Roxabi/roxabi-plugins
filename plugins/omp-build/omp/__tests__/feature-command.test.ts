import { describe, expect, it } from 'vitest'
import type { FeatureWorkflow } from '../../roxabi/feature-contract'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import ompBuildExtension from '../index'
import type { OmpBuildExtensionOptions } from '../omp-commands'
import type { NativeBatch } from '../review-runtime/contracts.ts'

const root = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

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
  const tools = new Set<string>()
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
    registerTool: (tool) => {
      tools.add(tool.name)
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
  return { sent, commands, tools, sessions, handlers, raw, pi }
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
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0]).toContain('/move /repo/feature')
    expect(host.sent[0]).toContain('/repo/feature')
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
          node: 'fixture',
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

  it('stops a branch-mismatch refusal without dispatching native work', async () => {
    let activated = false
    let announced = false
    const sent: string[] = []
    await runInstalledFeatureCommand('#12', {
      key: {},
      cwd: root.cwd,
      principal: false,
      workflow: workflow({
        continueFeature: async () => ({ kind: 'blocked', reason: 'branch-mismatch' }),
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
      send: async (message) => {
        sent.push(message)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      exec: async () => ({ code: 0, killed: false }),
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^feature-stopped:/)
    expect(activated).toBe(false)
    expect(announced).toBe(false)
  })
})

describe('installed correction lane', () => {
  it('registers no correction tool while retaining the /fix command', () => {
    const host = installed({})

    expect(host.tools.has('omp_build_start_fix')).toBe(false)
    expect(host.commands.has('fix')).toBe(true)
  })
})
