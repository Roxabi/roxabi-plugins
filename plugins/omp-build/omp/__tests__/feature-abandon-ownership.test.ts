import { createHash } from 'node:crypto'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordsOf } from '../../engine/workflow-control.ts'
import type { FeatureAuthority } from '../../roxabi/feature-continuation-admission.ts'
import { applyFeatureControl } from '../../roxabi/feature-continuation-controls.ts'
import { inhibit, inhibition, releaseInhibition } from '../../roxabi/feature-control.ts'
import { type Contracts, loadContracts } from '../../roxabi/feature-engine.ts'
import { implementationEffectAuthority } from '../../roxabi/feature-implementation-authorization.ts'
import type { ImplementationResultBinding } from '../../roxabi/feature-result-binding.ts'
import { type FixUwCausalContext, readFreshUwCausalContext } from '../../roxabi/fix-uw-histories.ts'
import type { PreparedUwAbandon, UwOperations } from '../../roxabi/uw-contract.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { manualOperatorDialog } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { cleanupFixtureActions } from '../../testing/review-runtime-support.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createOperatorConfirmation, reopenOperatorConfirmation } from '../omp-operator-confirmation.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'
import { batch, root } from './feature-command-lifecycle-fixture.ts'

vi.mock('../../roxabi/fix-uw-histories.ts', () => ({
  readFreshUwCausalContext: vi.fn(),
}))

/** Adapter/controller ownership intersections only — not genuine SDK/human E2E (Main: context-external-effect). */

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const cwd = '/work/abandon-ownership'
const fixtures = roxabiWorkflowFixtures()

/** Same digest rule as roxabi/uw-abandon.ts prepare → executeConfirmed. */
function preparedUwAbandon(): PreparedUwAbandon {
  const mandate = { scope, recordId: 'old-mandate', kind: 'mandate' as const }
  const proposal: PreparedUwAbandon['proposal'] = {
    format: 'omp-build-uw-abandon/1',
    operationId: 'abandon:acme-app-42',
    uw: scope,
    mandate,
    accepted: {
      uw: scope,
      version: 'a'.repeat(64),
      sourceAccepted: mandate,
    },
    historyDigest: 'b'.repeat(64),
    nativeDigest: 'c'.repeat(64),
  }
  return {
    proposal,
    digest: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
  }
}

afterEach(() => {
  releaseInhibition(scope)
  cleanupFixtureActions()
  vi.clearAllMocks()
})

function authority(gh: unknown, controlInhibition?: FeatureAuthority['controlInhibition']): FeatureAuthority {
  const target = {
    status: 'issue' as const,
    scope,
    issue: {
      repository: 'acme/app',
      number: 42,
      state: 'OPEN',
      author: 'automation',
      body: '',
      isPullRequest: false,
    },
  }
  return {
    context: {
      cwd,
      gh,
      engine: {
        resolveAcceptedSpec: () => ({ ok: true, spec: {} }),
        effectiveMandateRole: () => 'leaf',
      },
    },
    history: { source: { scope } },
    scope,
    selection: {
      status: 'applicable',
      mandate: { kind: 'mandate', recordId: 'old-mandate', payload: { role: 'leaf', branch: 'feat/42-save' } },
    },
    target,
    parentHistories: [],
    causal: { histories: [] },
    ...(controlInhibition === undefined ? {} : { controlInhibition }),
  } as unknown as FeatureAuthority
}

function confirmationContext(ui: ExtensionContext['ui']): ExtensionContext {
  return {
    agent: { kind: 'main', depth: 0, id: 'Main' },
    hasUI: true,
    mode: 'tui',
    isIdle: () => false,
    hasPendingMessages: () => true,
    ui,
    cwd,
    localProtocolOptions: consultableProtocolOptions(),
    sessionManager: {
      getSessionId: () => 'abandon-ownership-session',
      getCwd: () => cwd,
      getSessionFile: () => `${cwd}/root-session.jsonl`,
      getArtifactsDir: () => `${cwd}/artifacts`,
    },
  } as unknown as ExtensionContext
}

describe('feature abandon ownership', () => {
  it('hide→reopen confirm + mid-apply replacement still leaves the newer hold after targeted cleanup', async () => {
    const holdA = inhibit(scope, 'abandon')
    const dialog = manualOperatorDialog()
    const ctx = confirmationContext(dialog.ui)
    const operator = createOperatorConfirmation(ctx)
    const gh = vi.fn(async () => '[]')

    const pending = operator.executeConfirmed(preparedUwAbandon(), async () =>
      applyFeatureControl('abandon', authority(gh, holdA), {
        abandon: async () => {
          // Newer scope occupant while A is already applying after reopen.
          inhibit(scope, 'pause')
          return { status: 'abandoned' as const, uw: scope }
        },
      } as unknown as UwOperations),
    )

    const first = await dialog.nextMount()
    first.handleInput?.('\u001b')
    await operator.held
    expect(reopenOperatorConfirmation(ctx)).toBe('reopened')
    const second = await dialog.nextMount()
    second.handleInput?.('c')

    await expect(pending).resolves.toMatchObject({
      status: 'confirmed',
      value: { kind: 'abandoned', confirmed: true },
    })
    // applyFeatureControl released only holdA; replacement pause remains in effect.
    expect(inhibition(scope)).toBe('pause')
  })

  it('after stopJoined and confirmed abandon cleanup, the old batch stays fenced while a successor batch can announce', async () => {
    const controller = new NativeBatchController()
    const prepared = batch('old-tracked-batch')
    controller.activate(prepared, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(prepared)
    expect(controller.announce(prepared)).toBe(true)

    controller.inhibitFeatureContinuation()
    const stopped = await controller.stopJoined('abandon')
    expect(stopped.failures).toEqual([])
    expect(controller.current(prepared)).toBe(false)

    const hold = inhibit(scope, 'abandon')
    const gh = vi.fn(async () => '[]')
    const result = await applyFeatureControl('abandon', authority(gh, hold), {
      abandon: async () => ({ status: 'abandoned' as const, uw: scope }),
    } as unknown as UwOperations)
    expect(result).toEqual({ kind: 'abandoned', confirmed: true })
    expect(inhibition(scope)).toBeUndefined()

    // Scope cleanup does not reopen the old tracked batch fence. Successor id is a controller batch only — not an authenticated mandate.
    expect(controller.featureContinuationInhibited()).toBe(true)
    expect(controller.current(prepared)).toBe(false)
    expect(controller.consumeFollowUp()).toBeNull()

    controller.inactive()
    const successorBatch = batch('successor-controller-batch')
    controller.activate(successorBatch, { onComplete: async () => undefined, onStop: async () => undefined })
    controller.markFeatureBatch(successorBatch)
    expect(controller.announce(successorBatch)).toBe(false)

    controller.releaseFeatureContinuation()
    expect(controller.announce(successorBatch)).toBe(true)
    // Announced/queued is not current/running — current requires follow-up dispatch + admit.
    expect(controller.current(prepared)).toBe(false)
    expect(controller.current(successorBatch)).toBe(false)
    expect(controller.consumeFollowUp()).toBe(successorBatch)
    expect(controller.admit(successorBatch, 'successor-call', root as never, () => true)).toBe(true)
    expect(controller.current(prepared)).toBe(false)
    expect(controller.current(successorBatch)).toBe(true)
  })

  it('refuses an exact old-mandate effect when fresh history selects a different applicable mandate', async () => {
    const oldMandate = fixtures.featureMandate(scope, {
      recordId: 'mandate-old',
      operationId: 'op-mandate-old',
      runId: 'run-old',
    })
    const successorMandate = fixtures.featureMandate(scope, {
      recordId: 'mandate-successor',
      operationId: 'op-mandate-successor',
      runId: 'run-successor',
      antecedent: { scope, recordId: oldMandate.recordId, kind: 'mandate' },
    })
    const startReceipt = fixtures.implementStart(oldMandate)
    if (startReceipt.kind !== 'action-receipt') throw new Error('implement START fixture unavailable')
    const startPayload = startReceipt.payload
    if (startPayload.phase !== 'start' || startPayload.action !== 'implement') {
      throw new Error('implement START fixture unavailable')
    }
    const start: ImplementationResultBinding['start'] = { ...startReceipt, payload: startPayload }
    const history = fixtures.historyFrom([oldMandate, start, successorMandate])
    const composed = {
      ok: true as const,
      scopes: [scope],
      histories: [history],
      records: recordsOf(history),
    }

    const contracts = await loadContracts()
    if ('missing' in contracts) throw new Error(`engine-unavailable:${contracts.missing}`)
    const loaded: Contracts = {
      ...contracts,
      readComposedWorkflowHistory: async () => composed,
      startResolution: () => ({ ok: true as const, value: null }),
      // Fresh selection returns the successor present in the same history — not a mocked withdrawn reason.
      selectApplicableMandate: () => ({ status: 'applicable', mandate: successorMandate }),
    }

    // Maintained native observation reader → branded catalogues/histories === observation.* identity.
    const observed = await observeFixtureNativeWorld({
      root: scope,
      nodes: [
        {
          scope,
          title: 'Abandon ownership',
          body: '',
          updatedAt: '2026-10-21T00:00:00Z',
          labels: [],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [history],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    const causal: FixUwCausalContext = {
      histories: observed.histories,
      catalogues: observed.catalogues,
      observation: observed.observation,
    }
    vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: causal })

    const binding: ImplementationResultBinding = {
      loaded,
      gh: async () => '',
      history,
      receiptScope: scope,
      start,
      mandate: { scope, recordId: oldMandate.recordId, kind: 'mandate' },
      branch: 'feat/42-save',
      exactInputs: { mandateId: oldMandate.recordId, planActionId: 'act-plan-1' },
      publicationParents: [],
      child: undefined,
    }

    expect(inhibition(scope)).toBeUndefined()
    const effect = await implementationEffectAuthority(binding, cwd)
    expect(effect).toEqual({ ok: false, reason: 'implementation-authority-withdrawn' })
    expect(successorMandate.recordId).not.toBe(oldMandate.recordId)
  })
})
