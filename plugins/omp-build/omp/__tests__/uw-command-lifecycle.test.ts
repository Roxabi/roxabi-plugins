import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { causeSisterInputSchema } from '../../engine/cause-disposition-schema.ts'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import type { UwOperationResult, UwOperations } from '../../roxabi/uw-contract.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { operatorDialogUi } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { batch } from '../../testing/review-runtime-support.ts'
import { installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
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
    sessionManager: { getSessionId: () => 'session-1' },
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
        cwd: '/repo/feature',
        agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 },
        localProtocolOptions: consultableProtocolOptions(),
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
})
