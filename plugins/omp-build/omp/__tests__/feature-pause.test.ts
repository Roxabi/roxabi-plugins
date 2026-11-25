import type { ExtensionCommandContext, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, expect, it, vi } from 'vitest'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { manualOperatorDialog, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import ompBuildExtension from '../index.ts'
import * as admission from '../omp-feature-admission.ts'

const uw = { repository: 'acme/widgets', target: 'acme/widgets#54' }
const approval: PreparedMaterialAcceptance = {
  digest: '8e6e37f6c1d14723bc8d8e4b5565d928',
  proposal: {
    format: 'omp-build-material-acceptance/2',
    operationId: 'accept-material-54',
    uw,
    mandate: { scope: uw, recordId: 'mandate-54', kind: 'mandate' },
    predecessor: { scope: uw, recordId: 'predecessor-54', kind: 'operator-control' },
    assessment: { scope: uw, recordId: 'assessment-54', kind: 'action-receipt' },
    classification: 'material',
    exactInputs: {} as PreparedMaterialAcceptance['proposal']['exactInputs'],
  },
}

function installed() {
  const dialog = manualOperatorDialog()
  const stop = new AbortController()
  const reports: string[] = []
  let idle = true
  let sessionId = 'feature-session'
  const origin = operatorRootContext('/repo/feature', consultableProtocolOptions())
  const ctx = {
    ...origin,
    hasUI: true,
    mode: 'tui',
    ui: { ...dialog.ui, notify: (message: string) => reports.push(message) },
    sessionManager: { ...origin.sessionManager, getSessionId: () => sessionId },
    isIdle: () => idle,
    abort: vi.fn(() => {
      stop.abort()
      idle = true
    }),
  } as unknown as ExtensionCommandContext
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>()
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>()
  const sent: string[] = []
  const applied = vi.fn()
  const pi = createExtensionApiStub({
    on: (name, listener) => {
      const listeners = events.get(name) ?? []
      listeners.push(listener as never)
      events.set(name, listeners)
    },
    registerCommand: (name, command) => {
      commands.set(name, command.handler)
    },
    sendUserMessage: async (message) => {
      sent.push(String(message))
    },
    sendMessage: (message) => {
      reports.push(typeof message === 'string' ? message : String(message.content))
    },
  })
  ompBuildExtension(pi, {
    principalCwd: () => false,
    uwOperations: ({ operator }) => ({
      ...fixtureUwOperations(),
      acceptMaterial: async () => {
        const result = await operator.executeConfirmed(approval, async () => {
          applied()
          return { status: 'accepted', value: {} as never } as const
        })
        return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: result.diagnostics }
      },
    }),
  })
  const emit = async (name: string, fields: Record<string, unknown> = {}) => {
    for (const listener of events.get(name) ?? []) await listener({ type: name, ...fields } as never, ctx)
  }
  const deliver = async (text: string) => {
    const message = { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
    await emit('message_start', { message })
    return message
  }
  return {
    applied,
    ctx,
    dialog,
    deliver,
    emit,
    reports,
    stop,
    invoke: (name: string, args: string) => {
      const command = commands.get(name)
      if (!command) throw new Error(`missing command: ${name}`)
      return command(args, ctx)
    },
    start: async (text = 'Unrelated turn') => {
      idle = false
      await emit('agent_start')
      return deliver(text)
    },
    dispatched: () => {
      const text = sent.at(-1)
      if (text === undefined) throw new Error('feature not dispatched')
      return text
    },
    changeSession: () => {
      sessionId = 'other-session'
    },
  }
}

function readyFeature() {
  const scope = { repository: 'acme/widgets', target: 'acme/widgets#12' }
  const version = 'a'.repeat(64)
  const own: admission.FeatureReady['acceptedSpec']['own'] = {
    uw: scope,
    version,
    sourceAccepted: { scope, recordId: 'mandate-12', kind: 'mandate' },
  }
  return vi.spyOn(admission, 'admitFeature').mockResolvedValue({
    kind: 'ready',
    repository: 'acme/widgets',
    issue: 12,
    pr: 54,
    mandate: 'mandate-12',
    base: 'main',
    branch: 'feat/12',
    worktree: '/repo/feature',
    acceptedSpec: {
      format: 'omp-build-spec-effective/2',
      resolution: 'resolved',
      own,
      versionVector: [own],
      spec: {
        format: 'omp-build-spec-content/1',
        version,
        criteria: [],
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: { origin: '', context: '', change: '' },
      },
      inherited: { invariants: [], exclusions: [] },
    },
    acceptedBodySha256: version,
    liveIssueBodyDiffers: false,
  })
}

afterEach(() => vi.restoreAllMocks())

it('leaves an unrelated pending /uw confirmation usable after /feature pause #999', async () => {
  const host = installed()
  const completion = host.invoke('uw', 'accept-material acme/widgets#54')
  const dialog = await host.dialog.nextMount()
  await host.invoke('feature', 'pause #999')
  expect(host.ctx.abort).not.toHaveBeenCalled()
  expect(host.reports).toContain('feature-not-running: 999')
  dialog.handleInput?.('c')
  await completion
  expect(host.applied).toHaveBeenCalledOnce()
})

it('does not abort an unrelated busy root even after the matching Feature was queued', async () => {
  const admit = readyFeature()
  const host = installed()
  await host.start()
  await host.invoke('feature', '#12')
  expect(host.dispatched()).toContain('issue: 12')
  await host.invoke('feature', 'pause #12')
  expect(host.ctx.abort).not.toHaveBeenCalled()
  expect(admit).toHaveBeenCalledOnce()
  expect(host.reports.at(-1)).toBe('feature-not-running: 12')
  await host.deliver(host.dispatched())
  await host.invoke('feature', 'pause #12')
  expect(host.ctx.abort).toHaveBeenCalledOnce()
  expect(host.reports.at(-1)).toBe('feature-paused: session only')
})

it.each(['acme/widgets#12', '#54'])('pauses only a delivered Feature matching %s in its root session', async (ref) => {
  readyFeature()
  const host = installed()
  await host.invoke('feature', '#12')
  await host.start(host.dispatched())
  await host.invoke('feature', 'pause #999')
  await host.invoke('feature', 'pause other/widgets#12')
  expect(host.ctx.abort).not.toHaveBeenCalled()
  await host.invoke('feature', `pause ${ref}`)
  expect(host.ctx.abort).toHaveBeenCalledOnce()
  expect(host.reports.slice(-3)).toEqual([
    'feature-not-running: 999',
    'feature-not-running: other/widgets#12',
    'feature-paused: session only',
  ])
})

it('keeps a standalone UW confirmation when pausing a Feature cancels an earlier root stop callback', async () => {
  readyFeature()
  const host = installed()
  await host.invoke('feature', '#12')
  await host.start(host.dispatched())
  const completion = host.invoke('uw', 'accept-material acme/widgets#54')
  const dialog = await host.dialog.nextMount()
  await host.emit('session_stop', { signal: host.stop.signal, messages: [] })
  await host.invoke('feature', 'pause #12')
  expect(host.ctx.abort).toHaveBeenCalledOnce()
  dialog.handleInput?.('c')
  await completion
  expect(host.applied).toHaveBeenCalledOnce()
})

it('does not reuse ownership after the Feature ends or in another session', async () => {
  readyFeature()
  const host = installed()
  await host.invoke('feature', '#12')
  const message = await host.start(host.dispatched())
  await host.emit('agent_end', { messages: [message] })
  await host.invoke('feature', 'pause #12')
  await host.invoke('feature', '#12')
  await host.start(host.dispatched())
  host.changeSession()
  await host.invoke('feature', 'pause #12')
  expect(host.ctx.abort).not.toHaveBeenCalled()
  expect(host.reports.filter((report) => report.startsWith('feature-'))).toEqual([
    'feature-not-running: 12',
    'feature-not-running: 12',
  ])
})
