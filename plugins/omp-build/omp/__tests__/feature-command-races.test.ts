import { beforeEach, describe, expect, it } from 'vitest'
import type { FeatureWorkflow } from '../../roxabi/feature-contract'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { consultableAgentRoot, consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import ompBuildExtension from '../index'
import type { OmpBuildExtensionOptions } from '../omp-commands'

type CapturedHandler = {
  invoke(...args: unknown[]): unknown
}['invoke']

const root = {
  ...consultableAgentRoot(),
  cwd: '/repo/feature',
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

beforeEach(() => {
  root.localProtocolOptions = consultableProtocolOptions()
  Object.assign(root.sessionManager, { getArtifactsDir: root.localProtocolOptions.getArtifactsDir })
})

function workflow(continueFeature: FeatureWorkflow['continueFeature']): FeatureWorkflow {
  return { continueFeature }
}

function installed(options: OmpBuildExtensionOptions) {
  const sent: string[] = []
  const statusMap = new Map<string, string>()
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
    sendUserMessage: async (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
  })
  provisionNativeRoot(root)
  const origin = { sessionId: root.sessionManager.getSessionId(), cwd: root.cwd }
  const context = {
    ...root,
    sessionManager: {
      ...root.sessionManager,
      getSessionId: () => origin.sessionId,
      getCwd: () => origin.cwd,
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) statusMap.delete(key)
        else statusMap.set(key, text)
      },
    },
  }
  ompBuildExtension(pi, { principalCwd: () => false, ...options })
  return { sent, statusMap, context, commands, sessions, origin }
}

describe('installed /feature command composition', () => {
  it.each(['session', 'cwd'] as const)('drops an admission result after its %s changes', async (changed) => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const featureWorkflow = workflow(async () => {
      started.resolve()
      await release.promise
      return { kind: 'blocked', reason: 'stale-admission' }
    })
    const host = installed({ featureWorkflow })
    const run = host.commands.get('feature')?.handler('#12', host.context)
    await started.promise
    if (changed === 'session') host.origin.sessionId = 'session-after-new'
    else host.origin.cwd = '/repo/other'
    release.resolve()
    await run
    expect(host.sent).toEqual([])
    expect(host.statusMap.has('omp-build-watch')).toBe(false)
  })

  it('drops an older admission when a replacement command reports first', async () => {
    const started = Promise.withResolvers<void>()
    const deferred = Promise.withResolvers<void>()
    const featureWorkflow = workflow(async ({ reference }) => {
      if (reference === '41') {
        started.resolve()
        await deferred.promise
      }
      return { kind: 'blocked', reason: `refusal-${reference}` }
    })
    const host = installed({ featureWorkflow })
    const old = host.commands.get('feature')?.handler('#41', host.context)
    await started.promise
    await host.commands.get('feature')?.handler('#42', host.context)
    deferred.resolve()
    await old
    expect(host.sent).toEqual(['feature-stopped: refusal-42'])
    expect(host.statusMap.get('omp-build-watch')).toContain('UW 42 · refusal-42')
    expect(host.statusMap.get('omp-build-watch')).not.toContain('refusal-41')
  })

  it('does not run another continuation when shutdown follows a completed command', async () => {
    const calls: string[] = []
    const featureWorkflow = workflow(async ({ control }) => {
      calls.push(control)
      return { kind: 'terminal', reason: 'done' }
    })
    const host = installed({ featureWorkflow })
    await host.commands.get('feature')?.handler('#12', host.context)
    await host.sessions.get('session_shutdown')?.({ signal: new AbortController().signal }, host.context)
    expect(calls).toEqual(['select'])
    expect(host.sent).toEqual([expect.stringMatching(/^feature-done:.*done/)])
  })
})
