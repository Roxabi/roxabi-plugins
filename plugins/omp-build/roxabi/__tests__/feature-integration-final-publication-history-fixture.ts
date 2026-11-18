import type { DecodedHistory } from '../../engine/history-schema.ts'
import { specDigest } from '../../engine/record-digests.ts'
import type { UwCompletionObservation } from '../../engine/uw-completion-types.ts'
import { INTERRUPTION_RESOLUTION_PREFIX } from '../../engine/workflow-interruption-proof.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import type { History } from '../feature-engine.ts'
import type { FixUwCausalContext } from '../fix-uw-histories.ts'

export const integrationPublicationScope = { repository: 'acme/app', target: 'acme/app#42' } as const

const mandateRef = {
  scope: integrationPublicationScope,
  recordId: 'mandate-1',
  kind: 'mandate' as const,
}

/** Empty complete history for the integration final-publication scope. */
export function emptyIntegrationPublicationHistory(): DecodedHistory {
  return {
    source: {
      scope: integrationPublicationScope,
      expectedAuthor: 'automation',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: [],
    diagnostics: [],
  }
}

/**
 * Typed complete causal topology (catalogues + observation + histories).
 * Used by the controlled `readFreshUwCausalContext` seam for production resolvePublication.
 */
export function fixtureCausalContext(histories: readonly DecodedHistory[]): FixUwCausalContext {
  const catalogues = fixtureHostReviewClassCatalogues()
  const root = histories[0]?.source.scope ?? integrationPublicationScope
  const observation: Extract<UwCompletionObservation, { status: 'complete' }> = {
    status: 'complete',
    root,
    graph: {
      status: 'complete',
      root,
      observedAt: '2026-10-21T00:00:00Z',
      nodes: [
        {
          uw: root,
          title: 'integrate final publication',
          raw: {
            reference: root.target,
            body: '',
            bodySha256: specDigest(''),
            lastEditedAt: '2026-10-21T00:00:00Z',
          },
          updatedAt: '2026-10-21T00:00:00Z',
          labels: [],
          wayfinderLabels: [],
          parent: null,
          children: [],
          blockers: [],
          native: { state: 'OPEN', stateReason: null },
        },
      ],
    },
    histories,
    catalogues,
    delivery: [{ uw: root, pullRequests: [], integrations: [], commits: [] }],
  }
  return { histories, catalogues, observation }
}

/** Mandate + START topology required by production startedActionReceipt / mandate parents. */
export function seedResolvePublicationHistory(
  history: History,
  tip: string,
  inputs: { manifest: { purpose: 'integrate' } },
): void {
  const scope = integrationPublicationScope
  history.operations.push(
    {
      operationId: 'mandate-1',
      recordId: 'mandate-1',
      kind: 'mandate',
      status: 'complete',
      parts: [],
      claimedKinds: ['mandate'],
      authority: 'authority',
      record: {
        kind: 'mandate',
        recordId: 'mandate-1',
        repository: scope.repository,
        target: scope.target,
        version: 1,
        runId: 'run-mandate',
        operationId: 'mandate-1',
        inputs: [],
        payload: { parent: null, branch: null, base: tip },
      } as never,
    },
    {
      operationId: 'action-1:start',
      recordId: 'start-1',
      kind: 'action-receipt',
      status: 'complete',
      parts: [],
      claimedKinds: ['action-receipt'],
      authority: 'authority',
      record: {
        kind: 'action-receipt',
        recordId: 'start-1',
        repository: scope.repository,
        target: scope.target,
        version: 1,
        runId: 'run-start',
        operationId: 'action-1:start',
        inputs: [],
        payload: {
          format: 'omp-build-action-receipt/2',
          phase: 'start',
          action: 'integrate',
          actionId: 'action-1',
          mandate: mandateRef,
          inputs,
          exactInputs: {},
        },
      } as never,
    },
  )
}

/** Competing RESULT: same action/START/mandate/inputs, different record + operation identity. */
export function seedCompetingResultReceipt(history: History, inputs: { manifest: { purpose: 'integrate' } }): void {
  history.operations.push({
    operationId: 'foreign-terminal:result',
    recordId: 'competing-result-1',
    kind: 'action-receipt',
    status: 'complete',
    parts: [],
    claimedKinds: ['action-receipt'],
    authority: 'authority',
    record: {
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'integrate',
        actionId: 'action-1',
        mandate: mandateRef,
        start: { scope: integrationPublicationScope, recordId: 'start-1', kind: 'action-receipt' },
        inputs,
      },
    } as never,
  })
}

/** Incomplete unrelated interruption-resolution → production resolutionIndex fails closed. */
export function seedInvalidInterruptionResolution(history: History): void {
  history.operations.push({
    operationId: `${INTERRUPTION_RESOLUTION_PREFIX}foreign-incomplete`,
    recordId: `${INTERRUPTION_RESOLUTION_PREFIX}foreign-incomplete`,
    kind: 'action-receipt',
    status: 'incomplete',
    parts: [],
    claimedKinds: [],
    authority: 'authority',
    record: null,
  })
}
