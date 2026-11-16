import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { recoveryAssociationFixture } from '../engine/__tests__/fix-recovery-association-fixture.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import {
  buildConfirmedFixRecoveryAdoption,
  buildConfirmedFixRecoveryClose,
  prepareFixRecoveryAdoption,
  prepareFixRecoveryClose,
} from '../engine/fix-recovery-close.ts'
import { makeFixRecoveryObservation } from '../engine/fix-recovery-observation.ts'
import { commentAsPartPin } from '../engine/fix-recovery-part-pins.ts'
import { recoveryClosedRequests } from '../engine/fix-recovery-projection.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { fixtureReviewCatalogueReads } from '../testing/action-input-fixtures.ts'
import { reconstructFixCheckpoint } from './fix-checkpoint-state.ts'

function required<T>(result: { ok: true; value: T } | { ok: false; diagnostics: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

function append(history: DecodedHistory, record: CanonicalRecord, serial: number): DecodedHistory {
  const parts = required(encodeParts(record, '', 65536))
  return decodeHistory({
    ...history.source,
    comments: [
      ...history.source.comments,
      ...parts.map((body, index) => ({
        locator: `checkpoint-recovery-${serial + index}`,
        nativeId: String(serial + index),
        author: history.source.expectedAuthor,
        body,
        createdAt: '2026-10-27T12:00:00Z',
        updatedAt: '2026-10-27T12:00:00Z',
      })),
    ],
  })
}

function pin<K extends 'mandate' | 'workflow-binding'>(history: DecodedHistory, kind: K) {
  const matches = history.operations.filter((operation) => operation.record?.kind === kind)
  const operation = matches[0]
  const record = operation?.record
  if (matches.length !== 1 || !record || record.kind !== kind) throw new Error(`Expected one ${kind}`)
  const parts = operation.parts
    .map((part) => {
      const value = commentAsPartPin(part)
      if (!value) throw new Error(`Unpinnable ${kind}`)
      return value
    })
    .sort((a, b) => a.part - b.part)
  return {
    identity: {
      scope: history.source.scope,
      kind,
      runId: record.runId,
      operationId: record.operationId,
      recordId: record.recordId,
    },
    envelopeDigest: canonicalValueDigest(record),
    parts,
  }
}

// Canonical framed structural histories, not a native owner or operator confirmation proof.
async function scenario(adoption = false) {
  const fixture = await recoveryAssociationFixture(adoption)
  const observed = fixture.observe({ review: adoption })
  const [home, pr] = observed.input.histories
  if (!home || !pr) throw new Error('Missing histories')
  const opening = home.operations.find(
    (operation) => operation.record?.kind === 'fix-owner' && operation.record.payload.phase === 'opened',
  )?.record
  const settled = home.operations.find(
    (operation) => operation.record?.kind === 'fix-owner' && operation.record.payload.phase === 'settled',
  )?.record
  const binding = pr.operations.find((operation) => operation.record?.kind === 'workflow-binding')?.record
  if (
    opening?.kind !== 'fix-owner' ||
    opening.payload.phase !== 'opened' ||
    settled?.kind !== 'fix-owner' ||
    settled.payload.phase !== 'settled' ||
    binding?.kind !== 'workflow-binding'
  )
    throw new Error('Missing anchors')
  const common = opening.payload.common
  if (common.host.kind !== 'linux-qualified') throw new Error('Expected qualified structural host')
  const current = {
    authority: {
      mandate: pin(home, 'mandate'),
      binding: pin(pr, 'workflow-binding'),
      plugin: common.plugin,
      configuration: common.configuration,
      accepted: common.accepted,
    },
    pullRequest: {
      scope: common.pullRequest,
      state: 'open' as const,
      candidateGitSHA: fixture.leaf.head,
      baseGitSHA: fixture.leaf.base,
      headRepository: common.destination.publicationRepository,
      branch: binding.payload.branch,
      base: binding.payload.base,
      destination: common.destination,
    },
    local: { ...settled.payload.local, status: { format: 'git-status-porcelain-v1' as const, stdout: '' } },
    host: {
      process: common.host.process,
      root: common.root,
      namespace: common.host.namespace,
      prior: { kind: 'sealed-drained-live' as const },
    },
    ...(adoption
      ? {
          catalogues: fixtureReviewCatalogueReads().map((entry) => ({
            ref: entry.ref,
            contents: new TextDecoder().decode(entry.contents.value),
          })),
        }
      : {}),
  }
  const histories = [home, pr]
  const observation = required(
    makeFixRecoveryObservation({ histories, graph: fixture.leaf.observation.graph, current }),
  )
  const control = {
    scope: common.pullRequest,
    kind: 'fix-recovery' as const,
    runId: 'checkpoint-close-run',
    operationId: 'checkpoint-close-op',
    recordId: 'checkpoint-close',
  }
  const confirmation = (digest: string) => ({
    route: 'omp-native-command' as const,
    operationId: control.operationId,
    proposalDigest: digest,
    confirmedAt: '2026-10-27T12:00:00Z',
  })
  const confirmed = adoption
    ? (() => {
        const claimReservation = {
          scope: fixture.leaf.uw,
          kind: 'fix-owner' as const,
          runId: 'checkpoint-claim-run',
          operationId: 'checkpoint-claim-op',
          recordId: 'checkpoint-claim',
        }
        const prepared = required(
          prepareFixRecoveryAdoption({
            control,
            claimReservation,
            observation,
            histories,
            graph: fixture.leaf.observation.graph,
            nativePreparation: { kind: 'no-native-action' },
          }),
        )
        return required(
          buildConfirmedFixRecoveryAdoption({
            prepared,
            fresh: prepared,
            histories,
            graph: fixture.leaf.observation.graph,
            confirmation: confirmation(prepared.digest),
          }),
        )
      })()
    : (() => {
        const prepared = required(prepareFixRecoveryClose({ control, observation, histories }))
        return required(
          buildConfirmedFixRecoveryClose({
            prepared,
            fresh: prepared,
            histories,
            confirmation: confirmation(prepared.digest),
          }),
        )
      })()
  return { fixture, observed, home, pr, confirmed }
}

describe('recovery-aware correction checkpoint', () => {
  it('closes only the old request and keeps a later request unresolved without deleting history', async () => {
    const { fixture, observed, home, pr, confirmed } = await scenario()
    expect(confirmed.payload.phase).toBe('close-predecision')
    const closedPr = append(pr, confirmed, 95000)
    expect(required(recoveryClosedRequests([home, closedPr]))).toEqual([
      { scope: fixture.leaf.pullRequest, kind: 'fix-request', recordId: fixture.requestId.recordId },
    ])
    expect(reconstructFixCheckpoint(closedPr, undefined, [home])).toEqual({ status: 'not-started' })
    const next = required(
      parseRecord({
        ...observed.request,
        recordId: 'new-request',
        operationId: 'new-request-operation',
        runId: 'new-request-run',
      }),
    )
    const withNext = append(closedPr, next, 96000)
    expect(reconstructFixCheckpoint(withNext, undefined, [home])).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: ['new-request'],
    })
    expect(withNext.source.comments).toEqual(expect.arrayContaining(pr.source.comments))
    expect(withNext.operations.filter((op) => op.record?.kind === 'fix-request').map((op) => op.recordId)).toEqual([
      fixture.requestId.recordId,
      'new-request',
    ])
  })

  it('does not suppress the same request ID in a different scope', async () => {
    const { fixture, observed, home, pr, confirmed } = await scenario()
    const closedPr = append(pr, confirmed, 95000)
    const otherScope = { repository: fixture.leaf.pullRequest.repository, target: 'acme/app#999' }
    const other = required(
      parseRecord({ ...observed.request, ...otherScope, runId: 'other-run', operationId: 'other-request-operation' }),
    )
    const empty = decodeHistory({ ...pr.source, scope: otherScope, comments: [] })
    const otherHistory = append(empty, other, 97000)
    expect(reconstructFixCheckpoint(otherHistory, undefined, [home, closedPr])).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: [fixture.requestId.recordId],
    })
  })

  it('does not turn an adoption control into a terminal close', async () => {
    const { fixture, home, pr, confirmed } = await scenario(true)
    expect(confirmed.payload.phase).toBe('adopt-decision')
    const adopted = append(pr, confirmed, 95000)
    expect(required(recoveryClosedRequests([home, adopted]))).toEqual([])
    expect(reconstructFixCheckpoint(adopted, undefined, [home])).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: [fixture.requestId.recordId],
    })
  })

  it('does not close an unconfirmed request or accept a validly encoded control with a changed confirmation', async () => {
    const { fixture, home, pr, confirmed } = await scenario()
    expect(required(recoveryClosedRequests([home, pr]))).toEqual([])
    expect(reconstructFixCheckpoint(pr, undefined, [home])).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: [fixture.requestId.recordId],
    })
    const invalid = required(
      parseRecord({
        ...confirmed,
        payload: {
          ...confirmed.payload,
          confirmation: { ...confirmed.payload.confirmation, proposalDigest: '2'.repeat(64) },
        },
      }),
    )
    const invalidPr = append(pr, invalid, 95000)
    expect(recoveryClosedRequests([home, invalidPr]).ok).toBe(false)
    expect(reconstructFixCheckpoint(invalidPr, undefined, [home])).toMatchObject({
      status: 'blocked',
      reason: 'incomplete-history',
    })
    expect(invalidPr.source.comments).toEqual(expect.arrayContaining(pr.source.comments))
  })
})
