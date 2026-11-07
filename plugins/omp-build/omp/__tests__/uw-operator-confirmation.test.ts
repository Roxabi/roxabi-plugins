import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { causeDependencyAdjustmentProposalSchema } from '../../engine/cause-dependency-adjustment-schema.ts'
import { nativeObservationDigest } from '../../engine/uw-native-observation-schema.ts'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import type { PreparedUwProposal, PreparedUwReopen } from '../../roxabi/uw-contract.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { createOperatorConfirmation } from '../omp-operator-confirmation.ts'

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

function materialProposal(): PreparedMaterialAcceptance {
  return {
    digest: '8e6e37f6c1d14723bc8d8e4b5565d928',
    proposal: {
      format: 'omp-build-material-acceptance/2',
      operationId: 'accept-material-acme-widgets-42',
      uw: { repository: 'acme/widgets', target: 'acme/widgets#42' },
      mandate: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'mandate-42',
        kind: 'mandate',
      },
      predecessor: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'predecessor-42',
        kind: 'operator-control',
      },
      assessment: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'assessment-42',
        kind: 'action-receipt',
      },
      classification: 'material',
      exactInputs: {} as PreparedMaterialAcceptance['proposal']['exactInputs'],
    },
  }
}

function interactiveContext(confirm: () => Promise<boolean>): ExtensionContext {
  return {
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: { confirm },
    localProtocolOptions: consultableProtocolOptions(),
  } as unknown as ExtensionContext
}

describe('native operator confirmation capability', () => {
  it('shows composed parent consent before the single creation confirmation', async () => {
    const prepared = {
      digest: 'c'.repeat(64),
      proposal: {
        format: 'omp-build-uw-proposal/1',
        operationId: 'create-42',
        operation: 'create',
        target: { kind: 'create', repository: 'acme/widgets' },
        title: 'New child',
        creation: { kind: 'sister', original: { repository: 'acme/widgets', target: 'acme/widgets#42' } },
        draft: {},
        parentAcceptance: {
          parentOperationId: 'parent-accept-42',
          slot: { kind: 'created-by', operationId: 'create-42' },
        },
      },
    } as unknown as PreparedUwProposal
    let displayed = ''
    let executed = false
    const context = {
      ...interactiveContext(async () => false),
      ui: {
        confirm: async (_title: string, message: string) => {
          displayed = message
          return false
        },
      },
    } as unknown as ExtensionContext
    const result = await createOperatorConfirmation(context).executeConfirmed(prepared, async () => {
      executed = true
    })
    expect(result.status).toBe('refused')
    expect(executed).toBe(false)
    expect(displayed).toContain('parent acceptance:')
    expect(displayed).toContain('parent-accept-42')
    expect(displayed).toContain('create-42')
  })

  it('shows the exact raw state and REOPENED effect before confirmation', async () => {
    const prepared = {
      digest: 'b'.repeat(64),
      proposal: {
        format: 'omp-build-uw-reopen/1',
        operationId: 'reopen-42',
        uw: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        accepted: {},
        before: { nativeState: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } },
        effect: { state: 'OPEN', stateReason: 'REOPENED' },
      },
    } as PreparedUwReopen
    let displayed = ''
    const context = {
      ...interactiveContext(async () => false),
      ui: {
        confirm: async (_title: string, message: string) => {
          displayed = message
          return false
        },
      },
    } as unknown as ExtensionContext
    let executed = false
    await createOperatorConfirmation(context).executeConfirmed(prepared, async () => {
      executed = true
    })
    expect(executed).toBe(false)
    expect(displayed).toContain('NOT_PLANNED')
    expect(displayed).toContain('REOPENED')
  })

  it('displays causal and native changes separately and does not execute a declined adjustment', async () => {
    const origin = { repository: 'acme/widgets', target: 'acme/widgets#42' }
    const blocker = { repository: 'acme/widgets', target: 'acme/widgets#43' }
    const mandate = { scope: origin, recordId: 'mandate-1', kind: 'mandate' as const }
    const accepted = { uw: origin, version: 'b'.repeat(64), sourceAccepted: mandate }
    const before = {
      issue: { repository: origin.repository, number: 42 },
      title: 'Origin',
      body: 'Exact body',
      updatedAt: '2026-01-01T00:00:00Z',
      nativeState: { state: 'OPEN' as const, stateReason: null },
      labels: [],
      parent: null,
      children: [],
      blockers: [{ repository: blocker.repository, number: 43 }],
    }
    const prepared = {
      digest: 'a'.repeat(64),
      proposal: causeDependencyAdjustmentProposalSchema.parse({
        format: 'omp-build-cause-dependency-adjustment/1',
        operationId: 'adjust-42',
        controlId: 'adjust-control',
        origin,
        mandate,
        accepted,
        versionVector: [accepted],
        disposition: { scope: origin, recordId: 'disposition-1', kind: 'cause-disposition' },
        receipt: { scope: origin, recordId: 'receipt-1', kind: 'debt-receipt' },
        predecessor: { scope: origin, recordId: 'receipt-1', kind: 'debt-receipt' },
        change: { kind: 'withdraw' },
        nativeEffect: { kind: 'update-blockers', remove: [blocker], add: [] },
        reason: 'No longer needed',
        references: [],
        before,
        nativeObservationDigest: nativeObservationDigest(before),
        histories: [{ scope: origin, digest: 'c'.repeat(64) }],
        nativeGraph: { root: origin, rows: [{ uw: origin, digest: nativeObservationDigest(before) }] },
      }),
    }
    let displayed = ''
    let executed = false
    const context = {
      ...interactiveContext(async () => false),
      ui: {
        confirm: async (_title: string, message: string) => {
          displayed = message
          return false
        },
      },
    } as unknown as ExtensionContext
    const result = await createOperatorConfirmation(context).executeConfirmed(prepared, async () => {
      executed = true
    })
    expect(result.status).toBe('refused')
    expect(executed).toBe(false)
    expect(displayed).toContain('causal change:')
    expect(displayed).toContain('withdraw')
    expect(displayed).toContain('native effect:')
    expect(displayed).toContain('acme/widgets#43')
  })

  it('shows the exact adjudication and does not execute it when declined', async () => {
    const uw = { repository: 'acme/widgets', target: 'acme/widgets#42' }
    const prepared = {
      digest: 'a'.repeat(64),
      proposal: {
        format: 'omp-build-cause-adjudication-proposal/1' as const,
        operationId: 'op-1',
        operation: 'adjudicate-cause' as const,
        uw,
        pending: { scope: uw, recordId: 'pending-1', kind: 'cause-disposition' as const },
        pendingDigest: 'b'.repeat(64),
        rejectedFindingIds: ['finding-1'],
        judgment: null,
        reason: 'The cited evidence disproves this finding',
        references: [],
      },
    }
    let displayed = ''
    const context = {
      ...interactiveContext(async () => false),
      ui: {
        confirm: async (_title: string, message: string) => {
          displayed = message
          return false
        },
      },
    } as unknown as ExtensionContext
    const effects: string[] = []
    const result = await createOperatorConfirmation(context).executeConfirmed(prepared, async () => {
      effects.push('written')
    })
    expect(result.status).toBe('refused')
    expect(displayed).toContain('pending-1')
    expect(displayed).toContain('finding-1')
    expect(displayed).toContain('disproves')
    expect(effects).toEqual([])
  })

  it('presents the semantic decision and UW identity before an operator declines', async () => {
    const prepared = structuredClone(proposal)
    prepared.proposal.title = 'Preserve payment audit'
    prepared.proposal.normalization = [
      {
        kind: 'kept',
        source: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        target: { kind: 'existing', id: 'C1' },
      },
      {
        kind: 'reworded',
        source: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
        target: { kind: 'existing', id: 'C2' },
        reason: 'Clarify',
      },
      { kind: 'removed', source: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } }, reason: 'Obsolete' },
    ]
    let displayed = ''
    const context = {
      ...interactiveContext(async () => false),
      ui: {
        confirm: async (_title: string, message: string) => {
          displayed = message
          return false
        },
      },
    } as unknown as ExtensionContext
    const result = await createOperatorConfirmation(context).executeConfirmed(prepared, async () => 'unexpected')
    expect(result.status).toBe('refused')
    for (const fact of [
      'acme/widgets',
      'acme/widgets#42',
      'normalize',
      'Preserve payment audit',
      'kept',
      'reworded',
      'removed',
    ]) {
      expect(displayed).toContain(fact)
    }
    expect(displayed).toContain(prepared.digest)
    expect(displayed).toMatch(/detail: .+/)
    displayed = ''
    const material = materialProposal()
    await createOperatorConfirmation(context).executeConfirmed(material, async () => 'unexpected')
    expect(displayed).toContain('acme/widgets#42')
    expect(displayed).toContain('material')
    expect(displayed).toContain('assessment-42')
  })

  it('prevents publication when the command becomes stale after the UI confirms', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    const operator = createOperatorConfirmation(interactiveContext(async () => confirmation.promise))
    const effects: string[] = []

    const result = operator.executeConfirmed(proposal, async () => {
      effects.push('published')
      return 'published'
    })
    operator.cancel()
    confirmation.resolve(true)

    await expect(result).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-confirmation-required' }],
    })
    expect(effects).toEqual([])
  })

  it('does not turn a declined native confirmation into an accepted effect', async () => {
    const operator = createOperatorConfirmation(interactiveContext(async () => false))
    const effects: string[] = []

    await expect(
      operator.executeConfirmed(proposal, async () => {
        effects.push('published')
        return 'published'
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-confirmation-declined' }],
    })

    expect(effects).toEqual([])
  })

  it('refuses publication when the displayed digest changes while confirmation is pending', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    const operator = createOperatorConfirmation(interactiveContext(async () => confirmation.promise))
    const prepared = structuredClone(proposal)
    const effects: string[] = []

    const result = operator.executeConfirmed(prepared, async () => {
      effects.push('published')
      return 'published'
    })
    prepared.digest = 'f'.repeat(32)
    confirmation.resolve(true)

    await expect(result).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-proposal-changed' }],
    })
    expect(effects).toEqual([])
  })

  it('refuses publication when the displayed UW proposal changes while confirmation is pending', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    const operator = createOperatorConfirmation(interactiveContext(async () => confirmation.promise))
    const prepared = structuredClone(proposal)
    const effects: string[] = []

    const result = operator.executeConfirmed(prepared, async () => {
      effects.push('published')
      return 'published'
    })
    if (prepared.proposal.target.kind !== 'existing') throw new Error('expected existing UW proposal')
    prepared.proposal.target.uw.target = 'acme/widgets#43'
    confirmation.resolve(true)

    await expect(result).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-proposal-changed' }],
    })
    expect(effects).toEqual([])
  })

  it('refuses publication when a displayed material proposal changes while confirmation is pending', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    const operator = createOperatorConfirmation(interactiveContext(async () => confirmation.promise))
    const prepared = materialProposal()
    const effects: string[] = []

    const result = operator.executeConfirmed(prepared, async () => {
      effects.push('published')
      return 'published'
    })
    prepared.proposal.assessment.recordId = 'assessment-43'
    confirmation.resolve(true)

    await expect(result).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-proposal-changed' }],
    })
    expect(effects).toEqual([])
  })

  it('allows the unchanged proposal that the operator confirmed', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    const operator = createOperatorConfirmation(interactiveContext(async () => confirmation.promise))
    const prepared = structuredClone(proposal)
    const effects: string[] = []

    const result = operator.executeConfirmed(prepared, async () => {
      effects.push('published')
      return 'published'
    })
    confirmation.resolve(true)

    await expect(result).resolves.toMatchObject({ status: 'confirmed', value: 'published' })
    expect(effects).toEqual(['published'])
  })

  it('consumes a confirmed command capability so concurrent and later calls cannot replay publication', async () => {
    const confirmation = Promise.withResolvers<boolean>()
    let confirmations = 0
    const operator = createOperatorConfirmation(
      interactiveContext(async () => {
        confirmations += 1
        return confirmation.promise
      }),
    )
    const effects: string[] = []

    const first = operator.executeConfirmed(proposal, async () => {
      effects.push('first-publication')
      return 'first-publication'
    })
    const concurrentReplay = operator.executeConfirmed(proposal, async () => {
      effects.push('concurrent-replay')
      return 'concurrent-replay'
    })
    confirmation.resolve(true)

    await expect(first).resolves.toMatchObject({ status: 'confirmed', value: 'first-publication' })
    await expect(concurrentReplay).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-confirmation-required' }],
    })
    await expect(
      operator.executeConfirmed(proposal, async () => {
        effects.push('later-replay')
        return 'later-replay'
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'operator-confirmation-required' }],
    })

    expect(confirmations).toBe(1)
    expect(effects).toEqual(['first-publication'])
  })
})
