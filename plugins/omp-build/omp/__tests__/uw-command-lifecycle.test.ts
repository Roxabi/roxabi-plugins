import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { causeSisterInputSchema } from '../../engine/cause-disposition-schema.ts'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import type { UwOperationResult, UwOperations } from '../../roxabi/uw-contract.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { manualOperatorDialog, operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch } from '../../testing/review-runtime-support.ts'
import { installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import { reopenOperatorConfirmation } from '../omp-operator-confirmation.ts'
import { parseUwCommand, registerUwCommand, type UwOperationsFactory } from '../omp-uw-command.ts'
import { reportResult } from '../omp-uw-result.ts'

const target = { repository: 'acme/widgets', target: 'acme/widgets#42' }

it('accepts only an explicit issue scope for subtree reports', () => {
  expect(parseUwCommand('reports acme/widgets#42')).toEqual({ kind: 'reports', repository: 'acme/widgets', number: 42 })
  expect(parseUwCommand('reports')).toMatchObject({ kind: 'invalid' })
  expect(parseUwCommand('reports acme/widgets#42 --confirmed')).toMatchObject({ kind: 'invalid' })
})
it('requires an exact issue and rejects confirmation flags for state controls and calculated reads', () => {
  for (const kind of ['abandon', 'reopen', 'read-effective', 'read-coverage', 'read-completion']) {
    expect(parseUwCommand(`${kind} acme/widgets#42`)).toEqual({ kind, repository: 'acme/widgets', number: 42 })
    expect(parseUwCommand(`${kind} acme/widgets#42 --confirmed`)).toMatchObject({ kind: 'invalid' })
  }
})

it('requires a request file and rejects confirmation flags for cause operations', () => {
  for (const kind of ['adjudicate', 'sister', 'promote-report', 'adjust-cause-dependency']) {
    expect(parseUwCommand(`${kind} --request-file /tmp/request.json`)).toEqual({
      kind,
      requestFile: '/tmp/request.json',
    })
    expect(parseUwCommand(`${kind} --request-file /tmp/request.json --confirmed`)).toMatchObject({ kind: 'invalid' })
    expect(parseUwCommand(`${kind} --confirmed`)).toMatchObject({ kind: 'invalid' })
  }
})

it('accepts explicit planned-child coverage without accepting a forged created-by identity', () => {
  const input = {
    disposition: { scope: target, kind: 'cause-disposition', recordId: 'cause' },
    factors: { scope: 1, complexity: 1, dependencies: 1, risk: 1 },
    tierOverride: null,
    labels: { add: [], remove: [] },
    parentCoverage: {
      parent: { uw: target, version: 'a'.repeat(64) },
      assignments: [{ criterion: 'C1', children: [{ kind: 'created-child' }] }],
    },
  }
  const coverage = causeSisterInputSchema.shape.parentCoverage.safeParse(input.parentCoverage)
  expect(coverage.success).toBe(true)
  expect(
    causeSisterInputSchema.shape.parentCoverage.safeParse({
      ...input.parentCoverage,
      assignments: [{ criterion: 'C1', children: [{ kind: 'created-by', operationId: 'forged' }] }],
    }).success,
  ).toBe(false)
})
it('retains an announced sister operation until terminal and revokes it on root session switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uw-cause-command-'))
  const requestFile = join(directory, 'request.json')
  writeFileSync(
    requestFile,
    JSON.stringify({
      disposition: { scope: target, recordId: 'cause', kind: 'cause-disposition' },
      factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
      tierOverride: null,
      labels: { add: [], remove: [] },
    }),
  )
  const commands = new Map<string, Command>()
  const listeners = new Map<string, Session[]>()
  const done = Promise.withResolvers<void>()
  const state: { signal?: AbortSignal } = {}
  const context = {
    cwd: directory,
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'session-1',
      getCwd: () => directory,
      getSessionFile: () => join(directory, 'session-1.jsonl'),
      getArtifactsDir: () => join(directory, 'artifacts'),
    },
    localProtocolOptions: consultableProtocolOptions(),
    ui: operatorDialogUi(async () => 'confirm'),
  } as unknown as ExtensionContext
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler as Session])
    },
    registerCommand: (name, command) => {
      commands.set(name, command as Command)
    },
  })
  installFeatureUwOperationLifecycle(pi)
  registerUwCommand(pi, ({ nativeHost }) => ({
    ...fixtureUwOperations(),
    createSister: async () => {
      if (nativeHost === undefined) throw new Error('missing native host')
      state.signal = nativeHost.signal
      const prepared = batch(['slot-a'])
      nativeHost.native.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
      nativeHost.onBatch(prepared)
      nativeHost.onStarted({
        creationOperationId: 'create-1',
        assessmentStart: { scope: target, recordId: 'assessment-start', kind: 'action-receipt' },
      })
      await done.promise
      return { status: 'refused', diagnostics: [] }
    },
  }))
  try {
    const command = commands.get('uw')
    if (command === undefined) throw new Error('uw-command-missing')
    await command.handler(`sister --request-file ${requestFile}`, context)
    expect(state.signal?.aborted).toBe(false)
    for (const listener of listeners.get('session_switch') ?? []) await listener({}, context)
    expect(state.signal?.aborted).toBe(true)
    done.resolve()
  } finally {
    done.resolve()
    rmSync(directory, { recursive: true, force: true })
  }
})

type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> }
type Session = (event: { signal?: AbortSignal }, context: ExtensionContext) => void | Promise<void>

function materialProposal(): PreparedMaterialAcceptance {
  return {
    digest: '8e6e37f6c1d14723bc8d8e4b5565d928',
    proposal: {
      format: 'omp-build-material-acceptance/2',
      operationId: 'accept-material-acme-widgets-42',
      uw: target,
      mandate: { scope: target, recordId: 'mandate-42', kind: 'mandate' },
      predecessor: { scope: target, recordId: 'predecessor-42', kind: 'operator-control' },
      assessment: { scope: target, recordId: 'assessment-42', kind: 'action-receipt' },
      classification: 'material',
      exactInputs: {} as PreparedMaterialAcceptance['proposal']['exactInputs'],
    },
  }
}

function heldCommandFixture(action: () => Promise<UwOperationResult>) {
  const dialog = manualOperatorDialog()
  const messages: string[] = []
  const sessions = new Map<string, Session>()
  let command: Command | undefined
  let calls = 0
  const location = {
    sessionId: 'held-session',
    artifacts: consultableProtocolOptions().getArtifactsDir(),
  }
  const context = {
    ...operatorRootContext('/repo/feature', { getArtifactsDir: () => location.artifacts }),
    hasUI: true,
    mode: 'tui',
    ui: dialog.ui,
    sessionManager: {
      getSessionId: () => location.sessionId,
      getCwd: () => '/repo/feature',
      getSessionFile: () => `/repo/feature/${location.sessionId}.jsonl`,
      getArtifactsDir: () => location.artifacts,
    },
    localProtocolOptions: { getArtifactsDir: () => location.artifacts },
  } as unknown as ExtensionContext
  const pi = createExtensionApiStub({
    on: (name, listener) => {
      sessions.set(name, listener as Session)
    },
    registerCommand: (_name, registered) => {
      command = registered as Command
    },
    sendMessage: (message) => {
      messages.push(typeof message === 'string' ? message : String(message.content))
    },
  })
  installFeatureUwOperationLifecycle(pi)
  registerUwCommand(pi, ({ operator }) => {
    calls += 1
    const first = calls === 1
    return {
      ...fixtureUwOperations(),
      acceptMaterial: async () => {
        if (!first) return { status: 'refused', diagnostics: [] }
        const result = await operator.executeConfirmed(materialProposal(), action)
        return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: result.diagnostics }
      },
    }
  })
  return {
    context,
    dialog,
    messages,
    start() {
      if (command === undefined) throw new Error('uw-command-missing')
      return command.handler('accept-material acme/widgets#42', context)
    },
    async newSession() {
      location.sessionId = 'next-session'
      location.artifacts = consultableProtocolOptions().getArtifactsDir()
      await sessions.get('session_switch')?.({}, context)
      return location.artifacts
    },
  }
}

/** One event-loop checkpoint drains promise-only completion, without a timed delay. */
function drainCommand(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function lifecycleFixture() {
  const commands = new Map<string, Command>()
  const sessions = new Map<string, Session>()
  const effects: string[] = []
  let nextPrompt = Promise.withResolvers<void>()
  const confirmations: Array<{ resolve(value: boolean): void }> = []
  const context = {
    cwd: '/repo/feature',
    agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => {
      const confirmation = Promise.withResolvers<boolean>()
      confirmations.push(confirmation)
      const prompted = nextPrompt
      nextPrompt = Promise.withResolvers<void>()
      prompted.resolve()
      return (await confirmation.promise) ? 'confirm' : 'refuse'
    }),
    localProtocolOptions: consultableProtocolOptions(),
    sessionManager: {
      getSessionId: () => 'root-session',
      getCwd: () => '/repo/feature',
      getSessionFile: () => '/repo/feature/root-session.jsonl',
      getArtifactsDir: () => '/repo/feature/artifacts',
    },
  } as unknown as ExtensionContext
  const childContext = {
    ...context,
    agent: { kind: 'main' as const, id: 'Child', name: 'child', depth: 1 },
  } as unknown as ExtensionContext
  const factory: UwOperationsFactory = ({ operator }) => {
    const accepted: UwOperationResult = { status: 'accepted', value: {} as never }
    return {
      listReports: async () => {
        throw new Error('unexpected-reports')
      },
      adjudicateCause: async () => {
        throw new Error('unexpected-adjudicate')
      },
      createSister: async () => {
        throw new Error('unexpected-sister')
      },
      adjustCauseDependency: async () => {
        throw new Error('unexpected-adjustment')
      },
      promoteReport: async () => {
        throw new Error('unexpected-promotion')
      },
      readUw: async () => {
        throw new Error('unexpected-read')
      },
      readEffective: async () => {
        throw new Error('unexpected-read-effective')
      },
      readCoverage: async () => {
        throw new Error('unexpected-read-coverage')
      },
      readCompletion: async () => {
        throw new Error('unexpected-read-completion')
      },
      closeLinked: async () => {
        throw new Error('unexpected-close-linked')
      },
      reopen: async () => {
        throw new Error('unexpected-reopen')
      },
      abandon: async () => {
        throw new Error('unexpected-abandon')
      },
      resolveInterruption: async () => {
        throw new Error('unexpected-interruption-resolution')
      },
      prepare: async () => {
        throw new Error('unexpected-prepare')
      },
      prepareFraming: async () => {
        throw new Error('unexpected-prepare-framing')
      },
      frame: async () => {
        throw new Error('unexpected-frame')
      },
      write: async () => {
        throw new Error('unexpected-write')
      },
      create: async () => {
        throw new Error('unexpected-create')
      },
      acceptMaterial: async () => {
        const result = await operator.executeConfirmed(materialProposal(), async () => {
          effects.push('accepted')
          return accepted
        })
        return result.status === 'confirmed' ? result.value : { status: 'refused', diagnostics: result.diagnostics }
      },
      prepareAction: async () => {
        throw new Error('unexpected-prepare-action')
      },
      prepareReviewActions: async () => {
        throw new Error('unexpected-prepare-review-actions')
      },
      replayActionInputs: async () => {
        throw new Error('unexpected-replay')
      },
      verifyAction: async () => {
        throw new Error('unexpected-verify')
      },
      readDelivery: async () => {
        throw new Error('unexpected-delivery')
      },
    } satisfies UwOperations
  }
  const pi = createExtensionApiStub({
    on: (event, handler) => {
      sessions.set(event, handler as Session)
    },
    registerCommand: (name, command) => {
      commands.set(name, command as Command)
    },
  })
  installFeatureUwOperationLifecycle(pi)
  registerUwCommand(pi, factory)
  const command = commands.get('uw')
  if (command === undefined) throw new Error('uw-command-missing')
  const start = (commandContext: ExtensionContext = context) => {
    const prompted = nextPrompt.promise
    const terminal = command.handler('accept-material acme/widgets#42', commandContext)
    return { terminal, prompted }
  }
  return {
    context,
    childContext,
    effects,
    start,
    settle(index: number, value: boolean) {
      confirmations[index]?.resolve(value)
    },
    session(name: 'session_stop' | 'session_switch' | 'session_shutdown', signal?: AbortSignal) {
      const listener = sessions.get(name)
      if (listener === undefined) throw new Error(`session-listener-missing:${name}`)
      return listener({ signal }, context)
    },
  }
}

describe('registered /uw command root lifecycle', () => {
  it('reports an adjudicated disposition using its authoritative scope', () => {
    const messages: string[] = []
    const pi = createExtensionApiStub({
      sendMessage: (message) => messages.push(typeof message === 'string' ? message : String(message.content)),
    })
    const context = { localProtocolOptions: consultableProtocolOptions() } as unknown as ExtensionContext
    reportResult(pi, context, {
      status: 'adjudicated',
      disposition: { scope: target, recordId: 'disposition-42', kind: 'cause-disposition' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('uw-adjudicated: acme/widgets#42')
    expect(messages[0]).not.toContain('no-trustworthy-uw')
  })

  it.each(['evidence', 'verdicts'] as const)(
    'reports a successful empty %s result and retains the consultable array',
    async (kind) => {
      let command: Command | undefined
      const messages: string[] = []
      const pi = createExtensionApiStub({
        registerCommand: (_name, value) => {
          command = value as Command
        },
        sendMessage: (message) => {
          messages.push(typeof message === 'string' ? message : String(message.content))
        },
      })
      installFeatureUwOperationLifecycle(pi)
      registerUwCommand(pi, () => ({
        ...fixtureUwOperations(),
        readDelivery: async (uw) => ({
          ok: true,
          value: { uw, effective: { ok: false, diagnostics: [] }, declarations: [], verdicts: [], diagnostics: [] },
        }),
      }))
      if (command === undefined) throw new Error('uw-command-missing')
      const context = {
        ...operatorRootContext('/repo/feature', consultableProtocolOptions()),
      } as unknown as ExtensionContext
      await command.handler(`${kind} acme/widgets#42`, context)
      expect(messages).toHaveLength(1)
      const summary = (messages[0] ?? '').split(' detail=')[0]
      expect(summary).not.toContain('malformed-result')
      expect(summary).toMatch(/\b0\b/)
      const detail = /detail=([^ ]+)/.exec(messages[0] ?? '')?.[1]
      expect(detail).toBeDefined()
      expect(JSON.parse(readFileSync(detail as string, 'utf8'))).toEqual([])
    },
  )

  it.each([
    ['aborted root stop', 'session_stop', true],
    ['root switch', 'session_switch', false],
    ['root shutdown', 'session_shutdown', false],
  ] as const)('does not publish after %s invalidates a pending exact confirmation', async (_label, event, aborted) => {
    const subject = lifecycleFixture()
    const pending = subject.start()
    await pending.prompted
    const controller = new AbortController()
    if (aborted) controller.abort()

    await subject.session(event, controller.signal)
    subject.settle(0, true)
    await pending.terminal

    expect(subject.effects).toEqual([])
  })

  it('does not let an old pending confirmation publish after a replacement /uw command', async () => {
    const subject = lifecycleFixture()
    const old = subject.start()
    await old.prompted
    const current = subject.start()
    await current.prompted

    subject.settle(0, true)
    await old.terminal
    subject.settle(1, true)
    await current.terminal

    expect(subject.effects).toEqual(['accepted'])
  })

  it('does not let a nonroot /uw command replace a pending root confirmation', async () => {
    const subject = lifecycleFixture()
    const root = subject.start()
    await root.prompted

    const child = subject.start(subject.childContext)
    await child.terminal
    expect(subject.effects).toEqual([])

    subject.settle(0, true)
    await root.terminal

    expect(subject.effects).toEqual(['accepted'])
  })

  it('allows the live exact confirmation to publish', async () => {
    const subject = lifecycleFixture()
    const pending = subject.start()
    await pending.prompted

    subject.settle(0, true)
    await pending.terminal

    expect(subject.effects).toEqual(['accepted'])
  })

  it('sets preparation status before the operations factory and does not let the older command clear the newer status', async () => {
    const statuses: Array<string | undefined> = []
    const order: string[] = []
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let calls = 0
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>()
    const pi = createExtensionApiStub({
      on: () => undefined,
      registerCommand: (name, command) => {
        commands.set(name, command as { handler: (args: string, ctx: ExtensionContext) => Promise<void> })
      },
    })
    installFeatureUwOperationLifecycle(pi)
    registerUwCommand(pi, async () => {
      const index = calls
      calls += 1
      order.push('factory')
      entered[index]?.resolve()
      await release[index]?.promise
      return { ...fixtureUwOperations(), acceptMaterial: async () => ({ status: 'refused', diagnostics: [] }) }
    })
    const command = commands.get('uw')
    if (command === undefined) throw new Error('uw-command-missing')
    const ctx = {
      cwd: '/repo/feature',
      agent: { kind: 'main', depth: 0, id: 'Main' },
      hasUI: true,
      mode: 'tui',
      sessionManager: {
        getSessionId: () => 'root-session',
        getCwd: () => '/repo/feature',
        getSessionFile: () => '/repo/feature/root-session.jsonl',
        getArtifactsDir: () => '/repo/feature/artifacts',
      },
      ui: {
        setStatus: (_key: string, text: string | undefined) => {
          statuses.push(text)
          order.push('status')
        },
      },
      localProtocolOptions: consultableProtocolOptions(),
    } as unknown as ExtensionContext
    const first = command.handler('accept-material acme/widgets#42', ctx)
    await entered[0]?.promise
    expect(order.indexOf('status')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('factory'))
    const second = command.handler('accept-material acme/widgets#42', ctx)
    await entered[1]?.promise
    const newer = statuses.at(-1)
    release[0]?.resolve()
    await first
    expect(statuses.at(-1)).toBe(newer)
    release[1]?.resolve()
    await second
  })

  it('reports one visible error after a held confirmation is reopened and its action fails', async () => {
    const subject = heldCommandFixture(async () => {
      throw new Error('confirmed-action-failed')
    })
    const command = subject.start()
    const first = await subject.dialog.nextMount()
    first.handleInput?.('\u001b')
    await command
    expect(reopenOperatorConfirmation(subject.context)).toBe('reopened')
    const reopened = await subject.dialog.nextMount()
    reopened.handleInput?.('c')
    await drainCommand()
    expect(subject.messages).toEqual(['uw-stopped: confirmed-action-failed'])
  })

  it('does not report a replaced held command whose confirmed action fails late', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const subject = heldCommandFixture(async () => {
      entered.resolve()
      await release.promise
      throw new Error('replaced-action-failed')
    })
    const command = subject.start()
    const first = await subject.dialog.nextMount()
    first.handleInput?.('\u001b')
    await command
    reopenOperatorConfirmation(subject.context)
    const reopened = await subject.dialog.nextMount()
    reopened.handleInput?.('c')
    await entered.promise
    await subject.start()
    release.resolve()
    await drainCommand()
    expect(subject.messages.filter((message) => message.includes('replaced-action-failed'))).toEqual([])
  })

  it('does not report or retain a held command result into the session created by /new', async () => {
    const effects: string[] = []
    const subject = heldCommandFixture(async () => {
      effects.push('authorized')
      return { status: 'refused', diagnostics: [] }
    })
    const command = subject.start()
    const first = await subject.dialog.nextMount()
    first.handleInput?.('\u001b')
    await command
    const nextArtifacts = await subject.newSession()
    first.handleInput?.('c')
    await drainCommand()
    expect(reopenOperatorConfirmation(subject.context)).not.toBe('reopened')
    expect(subject.messages).toEqual([])
    expect(effects).toEqual([])
    expect(readdirSync(nextArtifacts)).toEqual([])
  })
})
