import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import type { UwOperationResult, UwOperations } from '../../roxabi/uw-contract.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import { registerUwCommand, type UwOperationsFactory } from '../omp-uw-command.ts'

const target = { repository: 'acme/widgets', target: 'acme/widgets#42' }

type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> }
type Session = (event: { signal?: AbortSignal }, context: ExtensionContext) => void | Promise<void>

function materialProposal(): PreparedMaterialAcceptance {
  return {
    digest: '8e6e37f6c1d14723bc8d8e4b5565d928',
    proposal: {
      format: 'omp-build-material-acceptance/1',
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
    ui: {
      confirm: async () => {
        const confirmation = Promise.withResolvers<boolean>()
        confirmations.push(confirmation)
        const prompted = nextPrompt
        nextPrompt = Promise.withResolvers<void>()
        prompted.resolve()
        return confirmation.promise
      },
    },
    localProtocolOptions: consultableProtocolOptions(),
  } as unknown as ExtensionContext
  const childContext = {
    ...context,
    agent: { kind: 'main' as const, id: 'Child', name: 'child', depth: 1 },
  } as unknown as ExtensionContext
  const factory: UwOperationsFactory = ({ operator }) => {
    const accepted: UwOperationResult = { status: 'accepted', value: {} as never }
    return {
      readUw: async () => {
        throw new Error('unexpected-read')
      },
      prepare: async () => {
        throw new Error('unexpected-prepare')
      },
      validateNormalization: () => {
        throw new Error('unexpected-normalization')
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
