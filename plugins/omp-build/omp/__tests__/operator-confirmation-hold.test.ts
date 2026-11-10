import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { PreparedUwProposal } from '../../roxabi/uw-contract.ts'
import { manualOperatorDialog } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import type { OmpBuildExtensionApi } from '../omp-controller.ts'
import { beginFeatureUwOperation, installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import {
  cancelOperatorConfirmations,
  createOperatorConfirmation,
  reopenOperatorConfirmation,
} from '../omp-operator-confirmation.ts'

const proposal = {
  digest: '1c6e37f6c1d14723bc8d8e4b5565d928',
  proposal: {
    operationId: 'normalize-acme-widgets-42',
    operation: 'normalize',
    target: {
      kind: 'existing',
      uw: { repository: 'acme/widgets', target: 'acme/widgets#42' },
    },
  },
} as PreparedUwProposal

const other = {
  digest: '2c6e37f6c1d14723bc8d8e4b5565d928',
  proposal: {
    operationId: 'normalize-acme-widgets-43',
    operation: 'normalize',
    target: {
      kind: 'existing',
      uw: { repository: 'acme/widgets', target: 'acme/widgets#43' },
    },
  },
} as PreparedUwProposal

type LiveMapping = {
  cwd: string
  sessionFile: string
  artifactsDir: string
}

function liveMapping(): LiveMapping {
  return {
    cwd: '/repo/feature',
    sessionFile: '/repo/feature/root-session.jsonl',
    artifactsDir: '/repo/feature/artifacts',
  }
}

type LiveSession = {
  getSessionId(): string
  getCwd(): string
  getSessionFile(): string
  getArtifactsDir(): string
}

function sessionManager(mapping: LiveMapping = liveMapping()): LiveSession {
  return {
    getSessionId: () => 'root-session',
    getCwd: () => mapping.cwd,
    getSessionFile: () => mapping.sessionFile,
    getArtifactsDir: () => mapping.artifactsDir,
  }
}

function context(ui: ExtensionContext['ui'], idle = false, manager: LiveSession = sessionManager()): ExtensionContext {
  return {
    agent: { kind: 'main', depth: 0, id: 'Main' },
    hasUI: true,
    mode: 'tui',
    isIdle: () => idle,
    hasPendingMessages: () => !idle,
    ui,
    cwd: '/repo/feature',
    localProtocolOptions: consultableProtocolOptions(),
    sessionManager: manager,
  } as unknown as ExtensionContext
}

describe('held operator confirmation', () => {
  it('keeps the same prepared action across Escape and a busy reopen, then confirms once', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const operator = createOperatorConfirmation(ctx)
    const effects: string[] = []
    const digests: string[] = []
    const pending = operator.executeConfirmed(proposal, async (evidence) => {
      digests.push(evidence.proposalDigest)
      effects.push(evidence.operationId)
      return 'once'
    })
    const first = await dialog.nextMount()
    first.handleInput?.('\u001b')
    await operator.held
    expect(reopenOperatorConfirmation(ctx)).toBe('reopened')
    const second = await dialog.nextMount()
    first.handleInput?.('c')
    expect(effects).toEqual([])
    second.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', value: 'once' })
    expect(effects).toEqual([proposal.proposal.operationId])
    expect(digests).toEqual([proposal.digest])
  })

  it('does not confirm a proposal mutated while it was held', async () => {
    const prepared = structuredClone(proposal)
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const operator = createOperatorConfirmation(ctx)
    const effects: string[] = []
    const pending = operator.executeConfirmed(prepared, async () => {
      effects.push('written')
      return 'written'
    })
    const first = await dialog.nextMount()
    prepared.digest = 'changed'
    first.handleInput?.('\u001b')
    await operator.held
    expect(reopenOperatorConfirmation(ctx)).toBe('reopened')
    const second = await dialog.nextMount()
    second.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-proposal-changed' }],
    })
    expect(effects).toEqual([])
  })

  it('returns deferred without an effect only when the port policy is explicit defer', async () => {
    const dialog = manualOperatorDialog()
    const operator = createOperatorConfirmation(context(dialog.ui), { escape: 'defer' })
    const effects: string[] = []
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('written')
      return 'written'
    })
    const view = await dialog.nextMount()
    view.handleInput?.('\u001b')
    await expect(pending).resolves.toMatchObject({
      status: 'deferred',
      diagnostics: [{ code: 'operator-confirmation-deferred' }],
    })
    expect(effects).toEqual([])
    expect(reopenOperatorConfirmation(context(dialog.ui))).toBe('none')
  })

  it('shows the waiting port when the visible port hides, then reopens the latest held port once the lock is free', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const firstPort = createOperatorConfirmation(ctx)
    const secondPort = createOperatorConfirmation(ctx)
    const effects: string[] = []
    const first = firstPort.executeConfirmed(proposal, async () => {
      effects.push('first')
      return 'first'
    })
    await dialog.nextMount()
    const second = secondPort.executeConfirmed(other, async () => {
      effects.push('second')
      return 'second'
    })
    expect(dialog.views).toHaveLength(1)
    dialog.views[0]?.handleInput?.('\u001b')
    await firstPort.held
    const shown = await dialog.nextMount()
    expect(dialog.views).toHaveLength(2)
    const busy = dialog.views.length
    reopenOperatorConfirmation(ctx)
    expect(dialog.views).toHaveLength(busy)
    shown.handleInput?.('r')
    await expect(second).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
    expect(reopenOperatorConfirmation(ctx)).toBe('reopened')
    const restored = await dialog.nextMount()
    restored.handleInput?.('c')
    await expect(first).resolves.toMatchObject({ status: 'confirmed', value: 'first' })
    expect(effects).toEqual(['first'])
  })

  it('reports preparing as a handled reopen result', async () => {
    const dialog = manualOperatorDialog()
    const here = context(dialog.ui)
    const preparing = createOperatorConfirmation(here)
    preparing.progress('Reading fictional abandon')
    expect(reopenOperatorConfirmation(here)).toBe('preparing')
    expect(dialog.views).toHaveLength(0)
  })

  it('does not let a nested review port cancel the feature owner', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui, true)
    const listeners = new Map<string, (event: unknown, context: ExtensionContext) => void>()
    const pi = {
      on(event: string, listener: (event: unknown, context: ExtensionContext) => void) {
        listeners.set(event, listener)
      },
    } as OmpBuildExtensionApi
    installFeatureUwOperationLifecycle(pi)
    const feature = beginFeatureUwOperation(pi, createOperatorConfirmation(ctx))
    const review = createOperatorConfirmation(ctx)
    const effects: string[] = []
    const pending = feature.executeConfirmed(proposal, async () => {
      effects.push('feature')
      return 'feature'
    })
    const view = await dialog.nextMount()
    review.cancel()
    view.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', value: 'feature' })
    expect(effects).toEqual(['feature'])
  })

  it('settles visible, waiting, and held ports when a lifecycle event arrives on a fresh ui proxy', async () => {
    const dialog = manualOperatorDialog()
    const base = context(dialog.ui)
    const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => void>()
    const pi = {
      on(event: string, listener: (event: unknown, ctx: ExtensionContext) => void) {
        listeners.set(event, listener)
      },
    } as OmpBuildExtensionApi
    installFeatureUwOperationLifecycle(pi)
    const heldPort = createOperatorConfirmation(base)
    const visiblePort = createOperatorConfirmation(base)
    const waitingPort = createOperatorConfirmation(base)
    const effects: string[] = []
    const held = heldPort.executeConfirmed(proposal, async () => {
      effects.push('held')
      return 'held'
    })
    const first = await dialog.nextMount()
    first.handleInput?.('\u001b')
    await heldPort.held
    const visible = visiblePort.executeConfirmed(other, async () => {
      effects.push('visible')
      return 'visible'
    })
    await dialog.nextMount()
    const waiting = waitingPort.executeConfirmed(proposal, async () => {
      effects.push('waiting')
      return 'waiting'
    })
    const eventCtx = Object.create(base, { ui: { value: new Proxy(base.ui, {}) } }) as ExtensionContext
    const handler = listeners.get('session_switch')
    if (handler === undefined) throw new Error('session-switch-missing')
    handler({}, eventCtx)
    await expect(held).resolves.toMatchObject({ status: 'refused' })
    await expect(visible).resolves.toMatchObject({ status: 'refused' })
    await expect(waiting).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
  })

  it('does not cancel a live port when the event session manager throws', async () => {
    const dialog = manualOperatorDialog()
    const base = context(dialog.ui, true)
    const operator = createOperatorConfirmation(base)
    const effects: string[] = []
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('once')
      return 'once'
    })
    const view = await dialog.nextMount()
    const broken = Object.create(base, {
      sessionManager: {
        get() {
          throw new Error('session-unavailable')
        },
      },
    }) as ExtensionContext
    cancelOperatorConfirmations(broken, 'session-switch')
    view.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', value: 'once' })
    expect(effects).toEqual(['once'])
  })

  it('does not move the status writer while another port still has a live entry', async () => {
    const baseStatuses: Array<string | undefined> = []
    const proxyStatuses: Array<string | undefined> = []
    const dialog = manualOperatorDialog()
    const baseUi = {
      custom: dialog.ui.custom,
      setStatus: (_key: string, text: string | undefined) => {
        baseStatuses.push(text)
      },
    }
    const base = context(baseUi as ExtensionContext['ui'])
    const proxyCtx = Object.create(base, {
      ui: {
        value: {
          custom: dialog.ui.custom,
          setStatus: (_key: string, text: string | undefined) => {
            proxyStatuses.push(text)
          },
        },
      },
    }) as ExtensionContext
    const first = createOperatorConfirmation(base)
    first.progress('Reading fictional abandon')
    const second = createOperatorConfirmation(proxyCtx)
    second.progress('Other read')
    expect(baseStatuses.at(-1)).not.toBeUndefined()
    expect(baseStatuses).not.toContain(undefined)
    expect(proxyStatuses).toEqual([])
  })

  it('does not show or act when the live manager cwd moves and ctx.cwd stays', async () => {
    const dialog = manualOperatorDialog()
    const mapping = liveMapping()
    const ctx = context(dialog.ui, false, sessionManager(mapping))
    const effects: string[] = []
    mapping.cwd = '/repo/moved'
    const blocked = createOperatorConfirmation(ctx)
    const blockedRun = blocked.executeConfirmed(proposal, async () => {
      effects.push('shown')
      return 'shown'
    })
    await expect(blockedRun).resolves.toMatchObject({ status: 'refused' })
    expect(dialog.views).toHaveLength(0)
    expect(effects).toEqual([])

    mapping.cwd = '/repo/feature'
    const operator = createOperatorConfirmation(ctx)
    const confirmed = operator.executeConfirmed(proposal, async () => {
      effects.push('acted')
      return 'acted'
    })
    const view = await dialog.nextMount()
    mapping.cwd = '/repo/moved'
    view.handleInput?.('c')
    await expect(confirmed).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])

    mapping.cwd = '/repo/feature'
    const heldPort = createOperatorConfirmation(ctx)
    const heldRun = heldPort.executeConfirmed(proposal, async () => {
      effects.push('reopened')
      return 'reopened'
    })
    const heldView = await dialog.nextMount()
    heldView.handleInput?.('\u001b')
    await heldPort.held
    mapping.cwd = '/repo/moved'
    const beforeReopen = dialog.views.length
    expect(reopenOperatorConfirmation(ctx)).not.toBe('reopened')
    expect(dialog.views).toHaveLength(beforeReopen)
    cancelOperatorConfirmations(ctx, 'relocated')
    await expect(heldRun).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
  })

  it('does not confirm or reopen when the session file or artifact directory is rebound and the cwd mapping is unchanged', async () => {
    const dialog = manualOperatorDialog()
    const mapping = liveMapping()
    const ctx = context(dialog.ui, false, sessionManager(mapping))
    const effects: string[] = []
    const operator = createOperatorConfirmation(ctx)
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('acted')
      return 'acted'
    })
    const view = await dialog.nextMount()
    mapping.sessionFile = '/repo/feature/other-session.jsonl'
    view.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])

    mapping.sessionFile = '/repo/feature/root-session.jsonl'
    const artifactPort = createOperatorConfirmation(ctx)
    const artifactRun = artifactPort.executeConfirmed(proposal, async () => {
      effects.push('artifact')
      return 'artifact'
    })
    const artifactView = await dialog.nextMount()
    mapping.artifactsDir = '/repo/feature/other-artifacts'
    artifactView.handleInput?.('c')
    await expect(artifactRun).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])

    mapping.artifactsDir = '/repo/feature/artifacts'
    const heldPort = createOperatorConfirmation(ctx)
    const heldRun = heldPort.executeConfirmed(proposal, async () => {
      effects.push('reopened')
      return 'reopened'
    })
    const heldView = await dialog.nextMount()
    heldView.handleInput?.('\u001b')
    await heldPort.held
    mapping.sessionFile = '/repo/other.jsonl'
    const beforeReopen = dialog.views.length
    expect(reopenOperatorConfirmation(ctx)).not.toBe('reopened')
    expect(dialog.views).toHaveLength(beforeReopen)
    cancelOperatorConfirmations(ctx, 'rebound')
    await expect(heldRun).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
  })

  it('releases the dialog when the operator confirms, before the approved action finishes, and keeps the next port status', async () => {
    const dialog = manualOperatorDialog()
    const statuses: Array<string | undefined> = []
    const ui = {
      custom: dialog.ui.custom,
      setStatus(_key: string, text: string | undefined) {
        statuses.push(text)
      },
    }
    const ctx = context(ui as ExtensionContext['ui'])
    const gate = Promise.withResolvers<void>()
    const firstPort = createOperatorConfirmation(ctx)
    const secondPort = createOperatorConfirmation(ctx)
    const effects: string[] = []
    const first = firstPort.executeConfirmed(proposal, async () => {
      effects.push('started')
      await gate.promise
      effects.push('finished')
      return 'first'
    })
    const firstView = await dialog.nextMount()
    const second = secondPort.executeConfirmed(other, async () => {
      effects.push('second')
      return 'second'
    })
    expect(dialog.views).toHaveLength(1)
    firstView.handleInput?.('c')
    const secondView = await dialog.nextMount()
    expect(effects).toEqual(['started'])
    secondPort.progress('Reading fictional abandon')
    const marked = statuses.at(-1)
    expect(marked).toBe('Reading fictional abandon')
    gate.resolve()
    await expect(first).resolves.toMatchObject({ status: 'confirmed', value: 'first' })
    expect(statuses.at(-1)).toBe(marked)
    secondView.handleInput?.('r')
    await expect(second).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual(['started', 'finished'])
  })

  it('refuses a held generic port when its execution signal aborts, and a late confirm cannot write', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const execution = new AbortController()
    const operator = createOperatorConfirmation(ctx, { signal: execution.signal })
    const effects: string[] = []
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('written')
      return 'written'
    })
    const view = await dialog.nextMount()
    view.handleInput?.('\u001b')
    await operator.held
    execution.abort()
    await expect(pending).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
    expect(reopenOperatorConfirmation(ctx)).toBe('none')
    view.handleInput?.('c')
    expect(effects).toEqual([])
    expect(dialog.views).toHaveLength(1)
    const next = createOperatorConfirmation(ctx)
    const nextRun = next.executeConfirmed(other, async () => {
      effects.push('next')
      return 'next'
    })
    const nextView = await dialog.nextMount()
    nextView.handleInput?.('c')
    await expect(nextRun).resolves.toMatchObject({ status: 'confirmed', value: 'next' })
    expect(effects).toEqual(['next'])
  })

  it('refuses a visible prompt when its execution signal aborts, and a late confirm cannot write', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const execution = new AbortController()
    const operator = createOperatorConfirmation(ctx, { signal: execution.signal })
    const effects: string[] = []
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('written')
      return 'written'
    })
    const view = await dialog.nextMount()
    execution.abort()
    await expect(pending).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
    expect(reopenOperatorConfirmation(ctx)).toBe('none')
    view.handleInput?.('c')
    expect(effects).toEqual([])
    expect(dialog.views).toHaveLength(1)
  })

  it('refuses a waiting port when its execution signal aborts without showing it', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const visibleExecution = new AbortController()
    const waitingExecution = new AbortController()
    const visiblePort = createOperatorConfirmation(ctx, { signal: visibleExecution.signal })
    const waitingPort = createOperatorConfirmation(ctx, { signal: waitingExecution.signal })
    const effects: string[] = []
    const visible = visiblePort.executeConfirmed(proposal, async () => {
      effects.push('visible')
      return 'visible'
    })
    const view = await dialog.nextMount()
    const waiting = waitingPort.executeConfirmed(other, async () => {
      effects.push('waiting')
      return 'waiting'
    })
    expect(dialog.views).toHaveLength(1)
    waitingExecution.abort()
    await expect(waiting).resolves.toMatchObject({ status: 'refused' })
    expect(dialog.views).toHaveLength(1)
    expect(effects).toEqual([])
    view.handleInput?.('r')
    await expect(visible).resolves.toMatchObject({ status: 'refused' })
    expect(effects).toEqual([])
  })

  it('does not show a proposal when the execution signal is already aborted', async () => {
    const dialog = manualOperatorDialog()
    const ctx = context(dialog.ui)
    const execution = new AbortController()
    execution.abort()
    const operator = createOperatorConfirmation(ctx, { signal: execution.signal })
    const effects: string[] = []
    const pending = operator.executeConfirmed(proposal, async () => {
      effects.push('written')
      return 'written'
    })
    const outcome = await Promise.race([
      pending.then((result) => ({ kind: 'settled' as const, result })),
      dialog.nextMount().then(() => ({ kind: 'mounted' as const })),
    ])
    expect(outcome.kind).toBe('settled')
    if (outcome.kind === 'settled') expect(outcome.result).toMatchObject({ status: 'refused' })
    expect(dialog.views).toHaveLength(0)
    expect(effects).toEqual([])
    expect(reopenOperatorConfirmation(ctx)).toBe('none')
  })
})
