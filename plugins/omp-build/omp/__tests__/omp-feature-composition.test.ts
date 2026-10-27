import { describe, expect, it } from 'vitest'
import type { OperatorConfirmationEvidence } from '../../engine/uw-identity-schema.ts'
import type { OperatorResult, PreparedOperatorProposal } from '../../roxabi/uw-contract.ts'
import type { OmpBuildExtensionApi } from '../omp-controller.ts'
import { beginFeatureUwOperation, installFeatureUwOperationLifecycle } from '../omp-feature-composition.ts'
import type { CommandOperatorPort } from '../omp-operator-confirmation.ts'

const root = {
  cwd: '/repo/feature',
  agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
}

type SessionStopListener = (event: { signal: AbortSignal }, context: typeof root) => void | Promise<void>

function commandPort(cancel: () => void): CommandOperatorPort {
  return {
    cancel,
    async executeConfirmed<T>(
      _proposal: PreparedOperatorProposal,
      action: (evidence: OperatorConfirmationEvidence) => Promise<T>,
    ): Promise<OperatorResult<T>> {
      return {
        status: 'confirmed',
        value: await action({
          route: 'omp-native-command',
          operationId: 'test-operation',
          proposalDigest: 'test-digest',
          confirmedAt: '2026-10-27T00:00:00.000Z',
        }),
      }
    },
  }
}

function lifecycle() {
  const listeners = new Map<string, SessionStopListener>()
  const pi = {
    on(event: string, listener: SessionStopListener) {
      listeners.set(event, listener)
    },
  } as OmpBuildExtensionApi
  let cancelled = 0
  const operator = commandPort(() => cancelled++)
  installFeatureUwOperationLifecycle(pi)
  beginFeatureUwOperation(pi, operator)
  const stop = listeners.get('session_stop')
  if (stop === undefined) throw new Error('session-stop-listener-missing')
  return {
    stop,
    cancelled: () => cancelled,
    replace: () => {
      let replacementCancelled = 0
      beginFeatureUwOperation(
        pi,
        commandPort(() => replacementCancelled++),
      )
      return () => replacementCancelled
    },
  }
}

describe('feature UW operation root lifecycle', () => {
  it('keeps the confirmation capability live for an ordinary root settlement', async () => {
    const subject = lifecycle()

    await subject.stop({ signal: new AbortController().signal }, root)

    expect(subject.cancelled()).toBe(0)
  })

  it('cancels when an initially ordinary root settlement aborts later', async () => {
    const subject = lifecycle()
    const abort = new AbortController()

    await subject.stop({ signal: abort.signal }, root)
    expect(subject.cancelled()).toBe(0)

    abort.abort()

    expect(subject.cancelled()).toBe(1)
  })

  it('does not cancel a replacement command when its prior ordinary stop aborts later', async () => {
    const subject = lifecycle()
    const abort = new AbortController()

    await subject.stop({ signal: abort.signal }, root)
    const replacementCancelled = subject.replace()
    abort.abort()

    expect(subject.cancelled()).toBe(1)
    expect(replacementCancelled()).toBe(0)
  })

  it('cancels the confirmation capability for an aborted root settlement', async () => {
    const subject = lifecycle()
    const abort = new AbortController()
    abort.abort()

    await subject.stop({ signal: abort.signal }, root)

    expect(subject.cancelled()).toBe(1)
  })
})
