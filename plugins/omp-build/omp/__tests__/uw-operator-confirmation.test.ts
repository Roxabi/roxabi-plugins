import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import type { PreparedUwProposal } from '../../roxabi/uw-contract.ts'
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
      format: 'omp-build-material-acceptance/1',
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
  } as unknown as ExtensionContext
}

describe('native operator confirmation capability', () => {
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
